import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true, defaultViewport: { width: 1600, height: 900 } });
const p = await b.newPage();
await p.goto("file:///C:/Users/mdhat/Desktop/urumi-ai-task/docs/architecture.svg");
await p.screenshot({ path: process.argv[2] });
await b.close();
