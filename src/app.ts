import express from 'express';
import axios from 'axios';
import { Request, Response } from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import util from 'util';
import stream from 'stream';
import Tesseract from 'tesseract.js';
import path from 'path';
import { Configuration, OpenAIApi } from 'openai';
const redis = require('redis');
const redisClient: any = redis.createClient();
redisClient.connect()

import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') })


const configuration = new Configuration({
    organization: process.env['OPENAI_ORGANIZATION'],
    apiKey: process.env['OPENAI_APIKEY'],
});
const openai = new OpenAIApi(configuration);

const pipeline = util.promisify(stream.pipeline);
const app = express();
app.use(bodyParser.json());

app.listen(3000, () => {
    console.log('Server is running on port 3000');
});

app.get('/', (req, res) => {
    res.send('Hello, Node.js with TypeScript and Express!');
});

app.post('/wati-image-received', async (req: Request, res: Response) => {
    console.log('\nINSIDE /wati-image-received')
    if (req.body.type == 'image') {

        const imageRecievedConfirmation = 'The image is being processed...'
        await sendWatiMessage(imageRecievedConfirmation, req.body.waId)

        const url = req.body.data
        const substring = "data/images/";
        const startIndex = url.indexOf(substring) + substring.length;
        const filename = substring + url.slice(startIndex);
        const result = await watiGetMedia(filename)
        const filePath = path.join(__dirname, '..', result);

        const tesseractResult: any = await Tesseract.recognize(filePath)
            .catch((error) => {
                console.error(error);
            });
        const tesseractResponse = tesseractResult.data.text;
        const foodItems = await getFoodItems(tesseractResponse)

        const redisData = await redisClient.get(req.body.waId)
        if (!redisData)
            await redisClient.set(req.body.waId, foodItems)
        else {
            await redisClient.set(req.body.waId, redisData + foodItems)
        }
        await sendWatiInteractiveButtonsForUpload(req.body.waId)

        fs.unlink(filePath, (err) => {
            if (err) {
                console.error('Error deleting file:', err);
            } else {
                console.log('File deleted successfully.');
            }
        });
    }
    res.send(200)
})

app.get('/get-meal-suggestion', async (req: Request, res: Response) => {
    console.log('\nINSIDE /get-meal-suggestion')
    const imageRecievedConfirmation = 'Please wait while we dish out a meal option for you!'
    await sendWatiMessage(imageRecievedConfirmation, req.headers.waid)
    const redisData = await redisClient.get(req.headers.waid)
    const mealSuggestion = await getMealSuggestions(redisData)

    const responseBody = (JSON.stringify(mealSuggestion)).replace(/"/g, '');
    await sendWatiMessage(responseBody, req.headers.waid)
    await redisClient.set('+' + req.headers.waid, mealSuggestion)

    await sendWatiInteractiveButtonsForAltMeal(req.headers.waid)
    res.send(200)
})

app.get('/get-alternate-meal-suggestion', async (req: Request, res: Response) => {
    console.log('\nINSIDE /get-alternate-meal-suggestion')
    const imageRecievedConfirmation = 'An alternate meal option is being created...'
    await sendWatiMessage(imageRecievedConfirmation, req.headers.waid)
    const redisData = await redisClient.get(req.headers.waid)
    const chatHistory = await redisClient.get('+' + req.headers.waid)
    const mealSuggestion = await getAlternateMealSuggestions(redisData, chatHistory)

    const responseBody = (JSON.stringify(mealSuggestion)).replace(/"/g, '');
    await sendWatiMessage(responseBody, req.headers.waid)

    const resolveConvoBody = 'Thanks for using HealthMate!'
    await sendWatiMessage(resolveConvoBody, req.headers.waid)

    await redisClient.del(req.headers.waid)
    await redisClient.del('+' + req.headers.waid)
    res.send(200)
})

async function getMealSuggestions(foodItems: any) {
    const openaiRes = await openai
        .createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [{
                role: "user", content: `Please suggest a meal for a diabetic person from ONLY the following food items with a very brief description. 
            : ${foodItems}
            The response should be like the following format that would be perfect for sending as a text in whatsapp:
            Here's a healthy meal option from the provided menu:
            1. Food Type (Appetizer, Main Course, etc)
               Food Item
            2. ...
            
            This is a <description>
            <wish them a good meal or something with an emoji>`
            }],
        })
        .catch((e) => {
            console.log(e);
        });
    return openaiRes?.data?.choices[0]?.message?.content
}

async function getAlternateMealSuggestions(foodItems: any, chatHistory: any) {
    const openaiRes = await openai
        .createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [{
                role: "user", content: `Please suggest a meal for a diabetic person from ONLY the following food items with a very brief description. 
            : ${foodItems}
            The response should be like the following format that would be perfect for sending as a text in whatsapp:
            Here's a healthy meal option from the provided menu:
            1. Food Type (Appetizer, Main Course, etc)
               Food Item
            2. ...
            
            This is a <description>
            <wish them a good meal or something with an emoji>`
            },
            {
                role: "assistant",
                content: chatHistory
            },
            {
                role: "user",
                content: "Suggest an alternative in the same format and requirements"
            }
            ],
        })
        .catch((e) => {
            console.log(e);
        });
    return openaiRes?.data?.choices[0]?.message?.content
}

async function getFoodItems(rawFoodItems: any) {
    const openaiRes = await openai
        .createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: `Identify the food items in this and respond with only the food items list: ${rawFoodItems}` }],
        })
        .catch((e) => {
            console.log(e);
        });
    return openaiRes?.data?.choices[0]?.message?.content
}

async function watiGetMedia(fileName: any): Promise<any> {
    try {
        const result = await axios.get(`https://live-server-9967.wati.io/api/file/download?fileName=${fileName}`, {
            headers: {
                Authorization: `Bearer ${process.env['WATI_TOKEN']}`,
            },
            responseType: 'stream'
        });

        const nameFile = fileName.slice(15);
        await pipeline(result.data, fs.createWriteStream(`./${nameFile}`));
        return `./${nameFile}`;

    } catch (error: any) {
        console.log(error, 'FAILURE');
    }
}

async function sendWatiMessage(message: any, mobilenumber: any) {
    await axios.post(`https://live-server-9967.wati.io/api/v1/sendSessionMessage/+${mobilenumber}?messageText=${message}`, {
    }, {

        headers: {
            Authorization: `Bearer ${process.env['WATI_TOKEN']}`,

        }
    },).catch((e) => { console.log("Error from wati: ", e) })
}

async function sendWatiInteractiveButtonsForUpload(mobilenumber: any) {
    await axios.post(`https://live-server-9967.wati.io/api/v1/sendInteractiveButtonsMessage?whatsappNumber=+${mobilenumber}`,

        {

            "body": "Would you like to upload another image of the menu?",
            "buttons": [
                {
                    "text": "Yes, there's more"
                },
                {
                    "text": "No, this is it"
                }
            ]
        }, {

        headers: {
            Authorization: `Bearer ${process.env['WATI_TOKEN']}`,

        },
    },).then((res) => { console.log(res) }).catch((e) => { console.log("Error from wati: ", e) })
}

async function sendWatiInteractiveButtonsForAltMeal(mobilenumber: any) {
    await axios.post(`https://live-server-9967.wati.io/api/v1/sendInteractiveButtonsMessage?whatsappNumber=+${mobilenumber}`,

        {

            "body": "Would you like an alternate meal option out of the provided menu?",
            "buttons": [
                {
                    "text": "Yes, please!"
                },
                {
                    "text": "No, this looks good."
                }
            ]
        }, {

        headers: {
            Authorization: `Bearer ${process.env['WATI_TOKEN']}`,

        },
    },).then((res) => { console.log(res) }).catch((e) => { console.log("Error from wati: ", e) })
}