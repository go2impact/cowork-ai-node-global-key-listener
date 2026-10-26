const fs = require("fs");
const https = require("https");
const {EventEmitter} = require("events");
const {PassThrough} = require("stream");

Object.defineProperty(process, "platform", {value: process.env.TEST_PLATFORM});
const originalGet = https.get;
const nativeTimeout = setTimeout;
let requests = 0;
https.get = (url, callback) => {
    requests++;
    const display = new URL(url);
    display.search = "";
    fs.appendFileSync(process.env.TEST_TRACE, `${display.href}\n`);
    if (
        process.env.TEST_RESPONSE === "real" ||
        (process.env.TEST_RESPONSE === "redirect-real" && requests > 1)
    )
        return originalGet(url, callback);
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
    const respond = () => {
        if (process.env.TEST_RESPONSE === "network") {
            clearInterval(hold);
            request.emit("error", new Error("injected network failure"));
            return;
        }
        response = new PassThrough();
        response.statusCode = process.env.TEST_RESPONSE === "status" ? 503 : 200;
        response.headers = {};
        const mode = process.env.TEST_RESPONSE;
        if (
            mode.startsWith("redirect-") &&
            (requests === 1 || mode === "redirect-loop")
        ) {
            response.statusCode = 302;
            const locations = {
                "redirect-real": `${url}?redirect_test=1`,
                "redirect-loop": url,
                "redirect-http": String(url).replace("https:", "http:"),
                "redirect-credentials": String(url).replace(
                    "https://",
                    "https://user:pass@"
                ),
                "redirect-foreign": "https://example.invalid/helper",
                "redirect-malformed": "https://[",
                "redirect-timeout": url,
                "redirect-late-timeout": url,
                "redirect-hash": url,
            };
            if (locations[mode]) response.headers.location = locations[mode];
        }
        callback(response);
        const bytes = Number(process.env.TEST_BYTES);
        switch (process.env.TEST_RESPONSE) {
            case "timeout":
            case "redirect-timeout":
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
    };
    if (process.env.TEST_RESPONSE === "redirect-late-timeout") nativeTimeout(respond, 50);
    else process.nextTick(respond);
    return request;
};

if (process.env.TEST_RESPONSE.includes("timeout")) {
    const originalTimeout = global.setTimeout;
    let timers = 0;
    global.setTimeout = (callback, delay, ...args) => {
        if (++timers > 1) throw new Error("Download deadline restarted");
        if (!(delay > 0 && delay <= 120000)) throw new Error("Unbounded timeout");
        return originalTimeout(callback, 20, ...args);
    };
}
