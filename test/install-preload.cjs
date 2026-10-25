const fs = require("fs");
const https = require("https");
const {EventEmitter} = require("events");
const {PassThrough} = require("stream");

Object.defineProperty(process, "platform", {value: process.env.TEST_PLATFORM});
const originalGet = https.get;
https.get = (url, callback) => {
    fs.appendFileSync(process.env.TEST_TRACE, `${url}\n`);
    if (process.env.TEST_RESPONSE === "real") return originalGet(url, callback);
    const request = new EventEmitter();
    const hold = setInterval(() => {}, 1000);
    let response;
    request.setTimeout = () => request;
    request.destroy = error => {
        clearInterval(hold);
        if (response) response.destroy();
        process.nextTick(() => request.emit("error", error || new Error("aborted")));
        return request;
    };
    process.nextTick(() => {
        if (process.env.TEST_RESPONSE === "network") {
            clearInterval(hold);
            request.emit("error", new Error("injected network failure"));
            return;
        }
        response = new PassThrough();
        response.statusCode = process.env.TEST_RESPONSE === "status" ? 503 : 200;
        response.headers = {};
        callback(response);
        const bytes = Number(process.env.TEST_BYTES);
        switch (process.env.TEST_RESPONSE) {
            case "timeout":
                return;
            case "interrupted":
                response.write(Buffer.alloc(16));
                response.destroy(new Error("injected interrupted response"));
                break;
            case "oversize":
                response.end(Buffer.alloc(bytes + 1));
                break;
            case "truncated":
                response.end(Buffer.alloc(bytes - 1));
                break;
            default:
                response.end(Buffer.alloc(bytes));
        }
        clearInterval(hold);
    });
    return request;
};

if (process.env.TEST_RESPONSE === "timeout") {
    const originalTimeout = global.setTimeout;
    global.setTimeout = (callback, delay, ...args) => {
        if (!(delay > 0 && delay <= 120000)) throw new Error("Unbounded timeout");
        return originalTimeout(callback, 20, ...args);
    };
}
