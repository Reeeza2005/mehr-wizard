// =============================================================================
// Mehr Unified Deployment Wizard (Master & Edge Nodes Factory)
// =============================================================================

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === "/api/get-account" && request.method === "POST") {
            return await handleGetAccount(request);
        }

        if (url.pathname === "/api/deploy" && request.method === "POST") {
            return await handleDeploy(request);
        }

        return new Response(getWizardHtml(), {
            headers: { "Content-Type": "text/html; charset=utf-8" }
        });
    }
};

async function handleGetAccount(request) {
    try {
        const { apiToken } = await request.json();
        if (!apiToken) return jsonRes(false, "توکن الزامی است.");

        const res = await fetch("https://api.cloudflare.com/client/v4/accounts", {
            headers: { Authorization: `Bearer ${apiToken}` }
        });
        const data = await res.json();
        if (!data.success || !data.result || data.result.length === 0) {
            return jsonRes(false, "توکن نامعتبر است یا دسترسی به اکانت ندارد.");
        }

        return jsonRes(true, "اکانت پیدا شد", {
            accountId: data.result[0].id,
            accountName: data.result[0].name
        });
    } catch (err) {
        return jsonRes(false, err.message);
    }
}

async function handleDeploy(request) {
    try {
        const { apiToken, accountId, targetType, workerName } = await request.json();
        if (!apiToken || !accountId || !workerName || !targetType) {
            return jsonRes(false, "تمام فیلدها الزامی هستند.");
        }

        const cleanName = workerName.toLowerCase().trim().replace(/[^a-z0-9-_]/g, "");

        if (targetType === "edge") {
            return await deployEdgeNode(apiToken, accountId, cleanName);
        } else if (targetType === "master") {
            return await deployMasterPanel(apiToken, accountId, cleanName);
        } else {
            return jsonRes(false, "نوع نصب نامعتبر است.");
        }
    } catch (err) {
        return jsonRes(false, err.message);
    }
}

// -----------------------------------------------------------------------------
// 1. نصب و استقرار نود فرعی (Edge Ghost Node)
// -----------------------------------------------------------------------------
async function deployEdgeNode(token, accountId, nodeName) {
    const nodeApiKey = "mehr_node_" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    
    // واکشی سورس به‌روز نود از مخزن رسمی mehr-panel
    const rawAgentRes = await fetch("https://raw.githubusercontent.com/Reeeza2005/mehr-panel/main/mehr-agent.js");
    if (!rawAgentRes.ok) {
        throw new Error("خطا در دریافت mehr-agent.js از گیت‌هاب مِهر.");
    }
    const agentSource = await rawAgentRes.text();

    const form = new FormData();
    const metadata = {
        main_module: "agent.js",
        compatibility_date: "2024-09-01",
        compatibility_flags: ["nodejs_compat"],
        bindings: [
            { type: "plain_text", name: "API_KEY", text: nodeApiKey }
        ]
    };

    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("agent.js", new Blob([agentSource], { type: "application/javascript+module" }), "agent.js");

    const deployRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${nodeName}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: form
    });

    const deployData = await deployRes.json();
    if (!deployData.success) {
        throw new Error(deployData.errors?.[0]?.message || "خطا در دیپلوی نود فرعی.");
    }

    await enableWorkerSubdomain(accountId, token, nodeName);
    const finalUrl = await getWorkerUrl(accountId, token, nodeName);

    return jsonRes(true, "نود فرعی با موفقیت دیپلوی شد.", {
        type: "edge",
        url: finalUrl,
        apiKey: nodeApiKey,
        name: nodeName
    });
}

// -----------------------------------------------------------------------------
// 2. نصب و استقرار پنل اصلی مهر (Master Panel)
// -----------------------------------------------------------------------------
async function deployMasterPanel(token, accountId, panelName) {
    const d1Id = await getOrCreateD1(accountId, token, "super_panel_db");

    // واکشی فایل‌های ورکر و داشبورد از مخزن رسمی mehr-panel
    const [workerRes, dashRes] = await Promise.all([
        fetch("https://raw.githubusercontent.com/Reeeza2005/mehr-panel/main/_worker.js"),
        fetch("https://raw.githubusercontent.com/Reeeza2005/mehr-panel/main/dashboard.html")
    ]);

    if (!workerRes.ok || !dashRes.ok) {
        throw new Error("خطا در دریافت سورس‌های پنل (_worker.js یا dashboard.html) از گیت‌هاب مِهر.");
    }

    let masterWorkerSource = await workerRes.text();
    const masterHtmlSource = await dashRes.text();

    // dashboard.html کی امپورٹ کو براہ راست متغیر میں بدلنا تاکہ ماڈیول کا مسئلہ حل ہو جائے
    masterWorkerSource = masterWorkerSource.replace(
        /import\s+HTML_CONTENT\s+from\s+["'\].\/dashboard(\.html|\.js)?["'\\\];?/,
        "const HTML_CONTENT = " + JSON.stringify(masterHtmlSource) + ";"
    );

    const form = new FormData();
    const metadata = {
        main_module: "_worker.js",
        compatibility_date: "2024-09-01",
        compatibility_flags: ["nodejs_compat"],
        bindings: [
            { type: "d1", name: "IOT_DB", id: d1Id }
        ]
    };

    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("_worker.js", new Blob([masterWorkerSource], { type: "application/javascript+module" }), "_worker.js");

    const deployRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${panelName}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: form
    });

    const deployData = await deployRes.json();
    if (!deployData.success) {
        throw new Error(deployData.errors?.[0]?.message || "خطا در دیپلوی پنل اصلی.");
    }

    await enableWorkerSubdomain(accountId, token, panelName);
    const rawUrl = await getWorkerUrl(accountId, token, panelName);
    const finalUrl = `${rawUrl.replace(/\/+$/, "")}/sync/dash`;

    return jsonRes(true, "پنل اصلی مهر با موفقیت دیپلوی و آپدیت شد!", {
        type: "master",
        url: finalUrl,
        rawUrl: rawUrl,
        name: panelName
    });
}

// -----------------------------------------------------------------------------
// Helper APIs
// -----------------------------------------------------------------------------
async function getOrCreateD1(accountId, token, dbName) {
    const listRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const listData = await listRes.json();
    if (listData.success && listData.result) {
        const found = listData.result.find(db => db.name === dbName);
        if (found) return found.uuid;
    }

    const createRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: dbName })
    });
    const createData = await createRes.json();
    if (!createData.success) {
        throw new Error(createData.errors?.[0]?.message || "خطا در ایجاد دیتابیس D1.");
    }
    return createData.result.uuid;
}

async function getOrCreateKV(accountId, token, kvTitle) {
    const listRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces?per_page=100`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const listData = await listRes.json();
    if (listData.success) {
        const found = listData.result.find(item => item.title === kvTitle);
        if (found) return found.id;
    }

    const createRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: kvTitle })
    });
    const createData = await createRes.json();
    if (!createData.success) {
        throw new Error(createData.errors?.[0]?.message || "خطا در ایجاد KV.");
    }
    return createData.result.id;
}

async function enableWorkerSubdomain(accountId, token, scriptName) {
    await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true })
    });
}

async function getWorkerUrl(accountId, token, scriptName) {
    const subRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const subData = await subRes.json();
    const subdomain = subData?.result?.subdomain || "";
    const cleanScript = scriptName.replace(/\.workers\.dev$/i, "").trim();
    if (subdomain) {
        return `https://${cleanScript}.${subdomain}.workers.dev`;
    }
    return `https://${cleanScript}.workers.dev`;
}

function jsonRes(success, message, data = null) {
    return new Response(JSON.stringify({ success, message, data }), {
        headers: { "Content-Type": "application/json; charset=utf-8" }
    });
}

function getWizardHtml() {
    return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ویزارد جامع راه‌اندازی مِهر</title>
    <style>
        :root {
            --bg: #090d16;
            --card: #131b2e;
            --border: #233354;
            --primary: #38bdf8;
            --primary-hover: #0ea5e9;
            --text: #f1f5f9;
            --text-muted: #94a3b8;
            --success: #10b981;
            --danger: #ef4444;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
        body {
            background-color: var(--bg);
            color: var(--text);
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 20px;
        }
        .card {
            background-color: var(--card);
            border: 1px solid var(--border);
            border-radius: 16px;
            width: 100%;
            max-width: 540px;
            padding: 32px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.5);
        }
        .badge {
            display: inline-block;
            background: rgba(56, 189, 248, 0.1);
            color: var(--primary);
            padding: 4px 12px;
            border-radius: 9999px;
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 12px;
            border: 1px solid rgba(56, 189, 248, 0.2);
        }
        h1 { font-size: 20px; margin-bottom: 8px; }
        p { color: var(--text-muted); font-size: 13px; line-height: 1.6; margin-bottom: 20px; }
        .token-helper {
            background: rgba(56, 189, 248, 0.05);
            border: 1px dashed rgba(56, 189, 248, 0.3);
            border-radius: 10px;
            padding: 12px;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .token-helper span { font-size: 12px; color: var(--text-muted); }
        .btn-link {
            background: rgba(56, 189, 248, 0.2);
            color: var(--primary);
            padding: 6px 12px;
            border-radius: 6px;
            text-decoration: none;
            font-size: 12px;
            font-weight: 600;
            white-space: nowrap;
            transition: all 0.2s;
        }
        .btn-link:hover { background: var(--primary); color: #000; }
        .field { margin-bottom: 16px; }
        label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
        input, select {
            width: 100%;
            background: #0b1120;
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 12px;
            color: #fff;
            font-size: 13px;
            outline: none;
        }
        input { direction: ltr; }
        input:focus, select:focus { border-color: var(--primary); }
        .account-badge {
            font-size: 12px;
            color: var(--success);
            margin-top: 4px;
            display: none;
        }
        .btn {
            width: 100%;
            background: var(--primary);
            color: #031525;
            font-weight: 600;
            padding: 14px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 14px;
            margin-top: 8px;
            transition: all 0.2s;
        }
        .btn:hover { background: var(--primary-hover); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .result-box {
            margin-top: 24px;
            background: #080c14;
            border: 1px solid #1e293b;
            border-radius: 8px;
            padding: 16px;
            display: none;
        }
        .result-item { margin-bottom: 12px; }
        .result-label { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
        .result-val {
            background: #111827;
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-family: monospace;
            word-break: break-all;
            direction: ltr;
            text-align: left;
            border: 1px solid #1f2937;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .copy-btn {
            background: #1f2937;
            color: var(--primary);
            border: none;
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 11px;
            cursor: pointer;
            margin-right: 8px;
        }
        .status { margin-top: 12px; font-size: 13px; text-align: center; }
        .status.error { color: var(--danger); }
        .status.success { color: var(--success); }
        .open-dash-btn {
            display: inline-block;
            margin-top: 10px;
            background: var(--success);
            color: #031525;
            font-size: 12px;
            font-weight: 700;
            padding: 8px 16px;
            border-radius: 6px;
            text-decoration: none;
        }
    </style>
</head>
<body>
    <div class="card">
        <span class="badge">Mehr Deployment Hub</span>
        <h1>ویزارد جامع راه‌اندازی کلاستر مهر</h1>
        <p>پنل اصلی یا نودهای فرعی را با یک کلیک و بدون نیاز به ترمینال دیپلوی یا به‌روزرسانی کنید.</p>

        <div class="token-helper">
            <span>نیاز به ساخت یا بررسی توکن دارید؟</span>
            <a href="https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[{%22key%22:%22workers_scripts%22,%22type%22:%22edit%22},{%22key%22:%22workers_kv_storage%22,%22type%22:%22edit%22},{%22key%22:%22d1%22,%22type%22:%22edit%22},{%22key%22:%22account_settings%22,%22type%22:%22read%22}]&name=Mehr+Hub+Token" target="_blank" class="btn-link">🔑 ساخت خودکار توکن</a>
        </div>

        <div class="field">
            <label>Cloudflare API Token</label>
            <input type="password" id="apiToken" placeholder="توکن را پیست کنید" oninput="detectAccount()">
            <div class="account-badge" id="accountBadge"></div>
        </div>

        <div class="field">
            <label>عملیات مورد نظر</label>
            <select id="targetType" onchange="updateTargetUI()">
                <option value="master">🚀 نصب / به‌روزرسانی پنل اصلی (Master Panel)</option>
                <option value="edge">👻 راه‌اندازی نود فرعی جدید (Ghost Edge Node)</option>
            </select>
        </div>

        <div class="field">
            <label id="nameLabel">نام ورکر پنل اصلی</label>
            <input type="text" id="workerName" value="mehr" placeholder="نام ورکر">
        </div>

        <button class="btn" id="deployBtn" onclick="startDeploy()">⚡ شروع استقرار خودکار</button>
        <div class="status" id="statusMsg"></div>

        <div class="result-box" id="resultBox">
            <div class="result-item">
                <div class="result-label">🌐 آدرس ورکر مستقر شده:</div>
                <div class="result-val">
                    <span id="resUrl"></span>
                    <button class="copy-btn" onclick="copyText('resUrl')">کپی</button>
                </div>
            </div>
            <div class="result-item" id="keyBox">
                <div class="result-label">🔑 کلید اختصاصی نود (API Key):</div>
                <div class="result-val">
                    <span id="resKey"></span>
                    <button class="copy-btn" onclick="copyText('resKey')">کپی</button>
                </div>
            </div>
            <p id="resultDesc" style="margin: 12px 0 0; color: #10b981; font-size: 12px;"></p>
        </div>
    </div>

    <script>
        let detectedAccountId = "";

        function updateTargetUI() {
            const type = document.getElementById("targetType").value;
            const nameInput = document.getElementById("workerName");
            const label = document.getElementById("nameLabel");
            if (type === "master") {
                label.innerText = "نام ورکر پنل اصلی";
                nameInput.value = "mehr";
            } else {
                label.innerText = "نام ورکر نود فرعی";
                nameInput.value = "node-edge-2";
            }
        }

        async function detectAccount() {
            const token = document.getElementById("apiToken").value.trim();
            const badge = document.getElementById("accountBadge");
            if (token.length < 30) {
                badge.style.display = "none";
                return;
            }

            badge.style.display = "block";
            badge.style.color = "var(--primary)";
            badge.innerText = "⏳ در حال شناسایی اکانت...";

            try {
                const res = await fetch("/api/get-account", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ apiToken: token })
                });
                const data = await res.json();
                if (data.success) {
                    detectedAccountId = data.data.accountId;
                    badge.style.color = "var(--success)";
                    badge.innerText = "✓ اکانت شناسایی شد: " + data.data.accountName;
                } else {
                    badge.style.color = "var(--danger)";
                    badge.innerText = "✗ خطا: " + data.message;
                }
            } catch (err) {
                badge.style.color = "var(--danger)";
                badge.innerText = "✗ خطا در ارتباط با کلادفلر";
            }
        }

        async function startDeploy() {
            const apiToken = document.getElementById("apiToken").value.trim();
            const targetType = document.getElementById("targetType").value;
            const workerName = document.getElementById("workerName").value.trim();
            const btn = document.getElementById("deployBtn");
            const status = document.getElementById("statusMsg");
            const resultBox = document.getElementById("resultBox");

            if (!apiToken || !workerName) {
                status.className = "status error";
                status.innerText = "لطفاً توکن و نام ورکر را وارد کنید.";
                return;
            }

            if (!detectedAccountId) {
                await detectAccount();
                if (!detectedAccountId) {
                    status.className = "status error";
                    status.innerText = "شناسایی اکانت ناموفق بود. توکن را بررسی کنید.";
                    return;
                }
            }

            btn.disabled = true;
            btn.innerText = "⏳ در حال ساخت و دیپلوی روی کلادفلر...";
            status.className = "status";
            status.innerText = "";
            resultBox.style.display = "none";

            try {
                const res = await fetch("/api/deploy", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ apiToken, accountId: detectedAccountId, targetType, workerName })
                });
                const data = await res.json();

                if (data.success) {
                    status.className = "status success";
                    status.innerText = "استقرار با موفقیت انجام شد!";
                    document.getElementById("resUrl").innerText = data.data.url;
                    
                    const keyBox = document.getElementById("keyBox");
                    const resultDesc = document.getElementById("resultDesc");
                    if (data.data.type === "edge") {
                        keyBox.style.display = "block";
                        document.getElementById("resKey").innerText = data.data.apiKey;
                        resultDesc.innerText = "✅ نود فرعی آماده شد. آن را در پنل اصلی ثبت کنید.";
                    } else {
                        keyBox.style.display = "none";
                        resultDesc.innerHTML = '✅ پنل اصلی مستقر شد.<br><a href="' + data.data.url + '" target="_blank" class="open-dash-btn">🚀 ورود به داشبورد پنل مهر</a>';
                    }
                    resultBox.style.display = "block";
                } else {
                    status.className = "status error";
                    status.innerText = "خطا: " + data.message;
                }
            } catch (err) {
                status.className = "status error";
                status.innerText = "خطا: " + err.message;
            } finally {
                btn.disabled = false;
                btn.innerText = "⚡ شروع استقرار خودکار";
            }
        }

        function copyText(elementId) {
            const text = document.getElementById(elementId).innerText;
            navigator.clipboard.writeText(text).then(() => {
                alert("کپی شد!");
            });
        }
    </script>
</body>
</html>`;
}
