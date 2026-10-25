const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

const revision = "df009c2fb9ef190fbd1b7f5ff879c972adf6b4bc";
const assets = {
    win32: {
        file: "WinKeyServer.exe",
        bytes: 2350984,
        sha256: "51b5c13760909bbdd9b15be0d054389d9d47a487afbbf464b63e2f81a6ed9288",
        url: "https://github.com/go2impact/cowork-ai-node-global-key-listener/releases/download/native-assets-0.7.13-alpha/WinKeyServer.exe",
    },
    darwin: {
        file: "MacKeyServer",
        bytes: 113128,
        sha256: "30043996a56d0f6ad4ddb4186bd09ffc1050dcc352f641ce3907d35174086e15",
    },
    linux: {
        file: "X11KeyServer",
        bytes: 1068256,
        sha256: "6e09249262d9a605180dfbd0939379bbf9f37db076980d6ffda98d650f70a16d",
    },
};

function matches(file, asset) {
    let stat;
    try {
        stat = fs.lstatSync(file);
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
    if (!stat.isFile()) throw new Error(`Refusing nonregular destination: ${file}`);
    return (
        stat.size === asset.bytes &&
        crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") ===
            asset.sha256
    );
}

function checkDirectory(directory) {
    try {
        if (!fs.lstatSync(directory).isDirectory()) {
            throw new Error(`Refusing nonregular binary directory: ${directory}`);
        }
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
}

function download(asset) {
    const url =
        asset.url ||
        `https://raw.githubusercontent.com/go2impact/cowork-ai-node-global-key-listener/${revision}/bin/${asset.file}`;
    const hosts = new Set([
        new URL(url).hostname,
        "release-assets.githubusercontent.com",
    ]);
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        let activeRequest;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
        };
        const visit = (address, redirects) => {
            if (settled) return;
            let followed = false;
            const request = https.get(address, response => {
                if (settled) {
                    response.destroy();
                    return;
                }
                response.on("error", error => {
                    if (!followed) finish(error);
                });
                if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                    try {
                        if (redirects >= 3)
                            throw new Error("Asset redirect limit exceeded");
                        if (!response.headers.location)
                            throw new Error("Missing asset redirect location");
                        const next = new URL(response.headers.location, address);
                        if (
                            next.protocol !== "https:" ||
                            !hosts.has(next.hostname) ||
                            next.username ||
                            next.password ||
                            (next.port && next.port !== "443")
                        ) {
                            throw new Error("Refusing unsafe asset redirect");
                        }
                        followed = true;
                        response.destroy();
                        request.destroy();
                        visit(next.href, redirects + 1);
                    } catch (error) {
                        finish(new Error(`Invalid asset redirect: ${error.message}`));
                        request.destroy();
                    }
                    return;
                }
                if (response.statusCode !== 200) {
                    response.resume();
                    finish(
                        new Error(`Asset download returned HTTP ${response.statusCode}`)
                    );
                    request.destroy();
                    return;
                }
                const chunks = [];
                let bytes = 0;
                response.on("data", chunk => {
                    bytes += chunk.length;
                    if (bytes > asset.bytes) {
                        finish(new Error("Asset download exceeds expected length"));
                        request.destroy();
                    } else chunks.push(chunk);
                });
                response.on("end", () => {
                    const data = Buffer.concat(chunks);
                    if (bytes !== asset.bytes) {
                        finish(new Error("Asset download has unexpected length"));
                    } else if (
                        crypto.createHash("sha256").update(data).digest("hex") !==
                        asset.sha256
                    ) {
                        finish(new Error("Asset download SHA-256 mismatch"));
                    } else finish(null, data);
                });
            });
            activeRequest = request;
            request.on("error", error => {
                if (!followed) finish(error);
            });
        };
        timer = setTimeout(() => {
            finish(new Error("Asset download exceeded 60000ms"));
            if (activeRequest) activeRequest.destroy();
        }, 60000);
        try {
            visit(url, 0);
        } catch (error) {
            finish(error);
        }
    });
}

async function install() {
    const asset = assets[process.platform];
    if (!asset) throw new Error(`Unsupported platform: ${process.platform}`);
    const directory = path.resolve(__dirname, "../bin");
    checkDirectory(directory);
    const destination = path.join(directory, asset.file);
    if (matches(destination, asset)) {
        fs.chmodSync(destination, 0o755);
        return;
    }
    const data = await download(asset);
    checkDirectory(directory);
    fs.mkdirSync(directory, {recursive: true});
    const temporary = path.join(
        directory,
        `.${asset.file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
    );
    try {
        fs.writeFileSync(temporary, data, {flag: "wx", mode: 0o755});
        if (!matches(temporary, asset))
            throw new Error("Staged asset failed verification");
        // Recheck the destination after network IO before replacing an ordinary file.
        matches(destination, asset);
        try {
            fs.renameSync(temporary, destination);
        } catch (error) {
            if (!matches(destination, asset)) throw error;
        }
        if (!matches(destination, asset))
            throw new Error("Installed asset failed verification");
        fs.chmodSync(destination, 0o755);
        console.log(`Installed ${asset.file} (${asset.sha256})`);
    } finally {
        try {
            fs.unlinkSync(temporary);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
}

install().catch(error => {
    console.error(`node-global-key-listener install failed: ${error.message}`);
    process.exitCode = 1;
});
