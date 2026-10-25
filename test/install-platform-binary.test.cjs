const assert = require("assert/strict");
const {spawn, execFileSync} = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {test} = require("node:test");

const root = path.resolve(__dirname, "..");
const assets = {
    win32: {
        file: "WinKeyServer.exe",
        bytes: 2335291,
        hash: "e58864cc22cd8ec17ae35dd810455d604aadab7c3f145b6c53b3c261855a4bb1",
    },
    darwin: {
        file: "MacKeyServer",
        bytes: 113128,
        hash: "30043996a56d0f6ad4ddb4186bd09ffc1050dcc352f641ce3907d35174086e15",
    },
    linux: {
        file: "X11KeyServer",
        bytes: 1068256,
        hash: "6e09249262d9a605180dfbd0939379bbf9f37db076980d6ffda98d650f70a16d",
    },
};
const nativeMagic = new Set([
    "4d5a",
    "7f454c46",
    "feedface",
    "feedfacf",
    "cefaedfe",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
]);
const digest = file =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function sandbox(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "key-listener-install-"));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.copyFileSync(
        path.join(root, "scripts/install-platform-binary.cjs"),
        path.join(dir, "scripts/install-platform-binary.cjs")
    );
    return dir;
}

function install(dir, platform, response = "real") {
    return new Promise((resolve, reject) => {
        const trace = path.join(
            dir,
            `requests-${crypto.randomBytes(5).toString("hex")}.txt`
        );
        const child = spawn(
            process.execPath,
            [
                "--require",
                path.join(__dirname, "install-preload.cjs"),
                path.join(dir, "scripts/install-platform-binary.cjs"),
            ],
            {
                cwd: os.tmpdir(),
                env: {
                    ...process.env,
                    TEST_PLATFORM: platform,
                    TEST_RESPONSE: response,
                    TEST_BYTES: String(assets[platform]?.bytes || 1),
                    TEST_TRACE: trace,
                },
            }
        );
        let output = "";
        child.stdout.on("data", data => {
            output += data;
        });
        child.stderr.on("data", data => {
            output += data;
        });
        child.on("error", reject);
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error("Installer exceeded test deadline"));
        }, 90000);
        child.on("close", code => {
            clearTimeout(timer);
            resolve({
                code,
                output,
                urls: fs.existsSync(trace)
                    ? fs.readFileSync(trace, "utf8").trim().split("\n")
                    : [],
            });
        });
    });
}

function assertSelected(dir, platform) {
    assert.deepEqual(fs.readdirSync(path.join(dir, "bin")), [assets[platform].file]);
    const file = path.join(dir, "bin", assets[platform].file);
    assert.equal(fs.statSync(file).size, assets[platform].bytes);
    assert.equal(digest(file), assets[platform].hash);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o111, 0o111);
}

test("current source contains no generated native executable payload", () => {
    const files = execFileSync("git", ["ls-files", "-z"], {cwd: root})
        .toString()
        .split("\0")
        .filter(Boolean);
    const native = files.filter(name => {
        const file = path.join(root, name);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
        const prefix = fs.readFileSync(file).subarray(0, 4).toString("hex");
        return nativeMagic.has(prefix) || nativeMagic.has(prefix.slice(0, 4));
    });
    assert.deepEqual(native, []);
});

test("npm package never contains installed native binaries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "key-listener-pack-"));
    try {
        const result = JSON.parse(
            execFileSync(
                process.platform === "win32" ? "npm.cmd" : "npm",
                ["pack", "--json", "--ignore-scripts", "--pack-destination", dir],
                {cwd: root, encoding: "utf8", shell: process.platform === "win32"}
            )
        );
        const files = result[0].files.map(file => file.path);
        assert.equal(
            files.some(file => file.startsWith("bin/") || file.startsWith(".research/")),
            false
        );
        assert(files.includes("scripts/install-platform-binary.cjs"));
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test("the current platform asset retains its original bytes and caches without network", async t => {
    for (const platform of [process.platform]) {
        await t.test(platform, async t => {
            const dir = sandbox(t);
            const result = await install(dir, platform);
            assert.equal(result.code, 0, result.output);
            assert.deepEqual(result.urls, [
                `https://raw.githubusercontent.com/go2impact/cowork-ai-node-global-key-listener/df009c2fb9ef190fbd1b7f5ff879c972adf6b4bc/bin/${assets[platform].file}`,
            ]);
            assertSelected(dir, platform);
            const cached = await install(dir, platform, "network");
            assert.equal(cached.code, 0, cached.output);
            assert.deepEqual(cached.urls, []);
            assertSelected(dir, platform);
        });
    }
});

test("download failures never leave a usable or partial native file", async t => {
    for (const mode of [
        "network",
        "status",
        "truncated",
        "oversize",
        "hash",
        "interrupted",
        "timeout",
    ]) {
        await t.test(mode, async t => {
            const dir = sandbox(t);
            const result = await install(dir, "win32", mode);
            assert.notEqual(result.code, 0, result.output);
            assert(
                !fs.existsSync(path.join(dir, "bin")) ||
                    fs.readdirSync(path.join(dir, "bin")).length === 0
            );
        });
    }
});

test("a bounded HTTPS redirect preserves the current platform asset digest", async t => {
    const dir = sandbox(t);
    const result = await install(dir, process.platform, "redirect-real");
    assert.equal(result.code, 0, result.output);
    assert.equal(result.urls.length, 2);
    assertSelected(dir, process.platform);
});

test("redirect boundaries fail closed without resetting the download deadline", async t => {
    const failures = [
        ["redirect-http", /redirect/i, 1],
        ["redirect-credentials", /redirect/i, 1],
        ["redirect-foreign", /redirect/i, 1],
        ["redirect-malformed", /redirect/i, 1],
        ["redirect-missing", /redirect/i, 1],
        ["redirect-loop", /redirect limit/i, 4],
        ["redirect-timeout", /exceeded 60000ms/i, 2],
        ["redirect-late-timeout", /exceeded 60000ms/i, 1],
        ["redirect-hash", /SHA-256 mismatch/i, 2],
    ];
    for (const [mode, reason, requests] of failures) {
        await t.test(mode, async t => {
            const dir = sandbox(t);
            const result = await install(dir, "win32", mode);
            assert.notEqual(result.code, 0, result.output);
            assert.match(result.output, reason);
            assert.equal(result.urls.length, requests);
            assert(
                !fs.existsSync(path.join(dir, "bin")) ||
                    fs.readdirSync(path.join(dir, "bin")).length === 0
            );
        });
    }
});

test("unsupported platform fails before requesting an asset", async t => {
    const dir = sandbox(t);
    const result = await install(dir, "freebsd");
    assert.notEqual(result.code, 0);
    assert.deepEqual(result.urls, []);
    assert(!fs.existsSync(path.join(dir, "bin")));
});

test("corrupt file is repaired and concurrent installs converge", async t => {
    const dir = sandbox(t);
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "bin", assets[process.platform].file), "corrupt");
    const results = await Promise.all([
        install(dir, process.platform),
        install(dir, process.platform),
    ]);
    for (const result of results) assert.equal(result.code, 0, result.output);
    assertSelected(dir, process.platform);
});

test("symlink or directory destination is rejected without replacing it", async t => {
    for (const kind of ["symlink", "directory"]) {
        await t.test(kind, async t => {
            const dir = sandbox(t);
            fs.mkdirSync(path.join(dir, "bin"));
            const target = path.join(dir, "bin", assets.win32.file);
            const outside = path.join(dir, "untouched");
            fs.writeFileSync(outside, "original");
            if (kind === "symlink") fs.symlinkSync(outside, target);
            else fs.mkdirSync(target);
            const result = await install(dir, "win32", "network");
            assert.notEqual(result.code, 0);
            assert.equal(fs.readFileSync(outside, "utf8"), "original");
            assert(
                kind === "symlink"
                    ? fs.lstatSync(target).isSymbolicLink()
                    : fs.statSync(target).isDirectory()
            );
        });
    }
});

test("a symlinked binary directory cannot redirect installation outside the package", async t => {
    const dir = sandbox(t);
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dir, "bin"), "dir");
    const result = await install(dir, process.platform);
    assert.notEqual(result.code, 0);
    assert.deepEqual(fs.readdirSync(outside), []);
});
