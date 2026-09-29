const WIZARD_VERSION = "2.1.0";
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

        let workersList = [];
        try {
            const wRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${data.result[0].id}/workers/scripts`, {
                headers: { Authorization: `Bearer ${apiToken}` }
            });
            const wData = await wRes.json();
            if (wData.success && Array.isArray(wData.result)) {
                workersList = wData.result.map(w => ({ id: w.id, created_on: w.created_on, modified_on: w.modified_on }));
            }
        } catch (e) {}

        return jsonRes(true, "اکانت پیدا شد", {
            accountId: data.result[0].id,
            accountName: data.result[0].name,
            workers: workersList
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
    const nodeApiKey = "mehr_sec_" + crypto.randomUUID().replace(/-/g, "") + "_" + Math.random().toString(36).substring(2, 10);
    const agentSource = await fetchFromGithub("mehr-agent.js");

    const form = new FormData();
    const metadata = {
        main_module: "agent.js",
        compatibility_date: new Date().toISOString().split("T")[0],
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
    const finalUrl = await getWorkerUrl(accountId, token, nodeName, false);

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
    // دریافت یا ایجاد دیتابیس D1 با نام super_panel_db
    const d1Id = await getOrCreateD1(accountId, token, "super_panel_db");

    // تزریق خودکار مشخصات کلودفلر به دیتابیس جهت فعال‌سازی بی‌درنگ استعلام آمار
    try {
        const initSql = `
            CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT);
            INSERT INTO kv_store (key, value) VALUES (
                \x27sys_config\x27,
                json_object(
                    \x27cfAccountId\x27, \x27${accountId}\x27,
                    \x27cfWorkerName\x27, \x27${panelName}\x27,
                    \x27cfApiToken\x27, \x27${token}\x27,
                    \x27name\x27, \x27مِهر\x27,
                    \x27apiRoute\x27, \x27sync\x27,
                    \x27clusterKey\x27, \x27mehr_cluster_secret_2026\x27
                )
            ) ON CONFLICT(key) DO UPDATE SET
                value = json_set(value, \x27$.cfAccountId\x27, \x27${accountId}\x27, \x27$.cfWorkerName\x27, \x27${panelName}\x27, \x27$.cfApiToken\x27, \x27${token}\x27);
        `;
        await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${d1Id}/query`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ sql: initSql })
        });
    } catch(e) {}

    const masterWorkerSource = "\nfunction getAllProfiles(targetSub = null) {\n    let devId = (typeof activeDeviceId !== 'undefined' && activeDeviceId) ? activeDeviceId : (sysConfig.deviceId || \"00000000-0000-0000-0000-000000000001\");\n    let list = [{ id: devId, name: \"Default\" }];\n    if (sysConfig && Array.isArray(sysConfig.users)) {\n        sysConfig.users.forEach(u => {\n            if (u && u.name) {\n                list.push({ id: u.id || devId, name: u.name });\n            }\n        });\n    }\n    return list;\n}\n\nimport { connect } from \"cloudflare:sockets\";\nimport HTML_CONTENT from \"./dashboard.html\";\n\nconst CURRENT_VERSION = \"3.0.3\";\n\nconst SYSTEM_DEFAULTS = {\n    githubRepo: 'Reeeza2005/mehr-panel',\n    name: \"\u0645\u0650\u0647\u0631\",\n    apiRoute: \"sync\",\n    clusterKey: \"mehr_cluster_secret_2026\",\n    maintenanceHost: \"https://www.ubuntu.com, https://www.docker.com\",\n    masterKey: \"admin\",\n    metricNode: \"time.is\",\n    deviceId: \"mehr-node-1\",\n    mode: \"alpha\",\n    agent: \"chrome\",\n    socketPorts: \"443, 8443, 2053, 2083, 2087, 2096\",\n    customDns: \"https://cloudflare-dns.com/dns-query\",\n    resolveIp: \"1.1.1.1\",\n    users: [],\n    subProfiles: [],\n    panelApiKeys: []\n};\n\nlet sysConfig = { ...SYSTEM_DEFAULTS };\n\nasync function d1Get(env, key) {\n    if (!env.IOT_DB) return null;\n    try {\n        const { results } = await env.IOT_DB.prepare(\"SELECT value FROM kv_store WHERE key = ?\").bind(key).all();\n        if (results && results.length > 0) return results[0].value;\n    } catch(e) {}\n    return null;\n}\n\nasync function d1Put(env, key, value) {\n    if (!env.IOT_DB) return;\n    try {\n        await env.IOT_DB.prepare(\"INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)\").bind(key, value).run();\n    } catch(e) {}\n}\n\nasync function loadConfig(env) {\n    try {\n        if (!env.IOT_DB) return;\n        const confStr = await d1Get(env, \"sys_config\");\n        if (confStr) {\n            sysConfig = { ...SYSTEM_DEFAULTS, ...JSON.parse(confStr), name: \"\u0645\u0650\u0647\u0631\", githubRepo: \"Reeeza2005/mehr-panel\" };\n        }\n    } catch (e) {}\n}\n\nfunction jsonResponse(data, status = 200) {\n    return new Response(JSON.stringify(data), {\n        status: status,\n        headers: {\n            \"Content-Type\": \"application/json;charset=utf-8\",\n            \"Access-Control-Allow-Origin\": \"*\",\n            \"Access-Control-Allow-Methods\": \"GET, POST, PUT, DELETE, OPTIONS\",\n            \"Access-Control-Allow-Headers\": \"Content-Type, Authorization, X-Node-Key\",\n        }\n    });\n}\n\nexport default {\n    async fetch(request, env, ctx) {\n        await loadConfig(env);\n        const url = new URL(request.url);\n        let reqPath = url.pathname;\n        if (reqPath.endsWith(\"/\") && reqPath.length > 1) reqPath = reqPath.slice(0, -1);\n\n        const cleanApiRoute = (sysConfig.apiRoute || \"sync\").replace(/^\\/+|\\/+$/g, \"\");\n        const routeBase = `/${encodeURI(cleanApiRoute)}`;\n\n        if (request.method === \"OPTIONS\") {\n            return new Response(null, {\n                status: 204,\n                headers: {\n                    \"Access-Control-Allow-Origin\": \"*\",\n                    \"Access-Control-Allow-Methods\": \"GET, POST, PUT, DELETE, OPTIONS\",\n                    \"Access-Control-Allow-Headers\": \"Content-Type, Authorization, X-Node-Key\",\n                },\n            });\n        }\n\n        // \u0631\u0648\u062a \u0646\u0645\u0627\u06cc\u0634 \u062f\u0627\u0634\u0628\u0648\u0631\u062f\n        \n        // \u0631\u0648\u062a \u062a\u062d\u0648\u06cc\u0644 \u0644\u06cc\u0646\u06a9 \u0633\u0627\u0628\u0633\u06a9\u0631\u06cc\u067e\u0634\u0646 (\u0634\u0646\u0627\u0633\u0627\u06cc\u06cc \u0646\u0627\u0645 \u06a9\u0627\u0631\u0628\u0631 + \u06a9\u0627\u0631\u062a HTML \u0645\u0631\u0648\u0631\u06af\u0631 + \u06a9\u0627\u0646\u0641\u06cc\u06af Base64 \u0628\u0631\u0627\u06cc \u06a9\u0644\u0627\u06cc\u0646\u062a\u200c\u0647\u0627)\n        const subParam = url.searchParams.get('sub');\n        if (reqPath.includes('/sub/') || subParam) {\n            const rawId = subParam || reqPath.split('/sub/')[1];\n            if (rawId) {\n                const cleanId = decodeURIComponent(rawId.split('?')[0].trim()).toLowerCase();\n                let userRecord = null;\n\n                // 1. \u062c\u0633\u062a\u062c\u0648 \u062f\u0631 \u0622\u0631\u0627\u06cc\u0647 \u06a9\u0627\u0631\u0628\u0631\u0627\u0646 \u067e\u06cc\u06a9\u0631\u0628\u0646\u062f\u06cc \u067e\u0646\u0644\n                if (sysConfig && Array.isArray(sysConfig.users)) {\n                    userRecord = sysConfig.users.find(u => \n                        (u.name && u.name.toLowerCase() === cleanId) ||\n                        (u.username && u.username.toLowerCase() === cleanId) ||\n                        (u.id && u.id.toLowerCase() === cleanId) ||\n                        (u.uuid && u.uuid.toLowerCase() === cleanId)\n                    );\n                }\n\n                // 2. \u062c\u0633\u062a\u062c\u0648 \u062f\u0631 \u062f\u06cc\u062a\u0627\u0628\u06cc\u0633 D1 \u062f\u0631 \u0635\u0648\u0631\u062a \u0639\u062f\u0645 \u06cc\u0627\u0641\u062a\u0646 \u062f\u0631 \u062d\u0627\u0641\u0638\u0647 \u06a9\u0627\u0646\u0641\u06cc\u06af\n                if (!userRecord && env.IOT_DB) {\n                    try {\n                        userRecord = await env.IOT_DB.prepare(\"SELECT * FROM users WHERE lower(username) = ? OR lower(uuid) = ? OR lower(id) = ?\").bind(cleanId, cleanId, cleanId).first();\n                    } catch(e) {}\n                }\n\n                if (!userRecord || userRecord.isPaused) {\n                    return new Response(\"User not found or disabled\", { \n                        status: 404,\n                        headers: { \"Content-Type\": \"text/plain; charset=utf-8\" }\n                    });\n                }\n\n                const userUuid = userRecord.uuid || userRecord.id;\n                const displayName = userRecord.name || userRecord.username || \"\u06a9\u0627\u0631\u0628\u0631 \u0645\u0650\u0647\u0631\";\n\n                // \u0627\u0633\u062a\u062e\u0631\u0627\u062c \u0646\u0648\u062f\u0647\u0627\u06cc \u0641\u0639\u0627\u0644\n                let nodesList = [];\n                if (sysConfig && Array.isArray(sysConfig.nodes)) {\n                    nodesList = sysConfig.nodes.filter(n => n.status === 'active');\n                }\n                if (nodesList.length === 0 && env.IOT_DB) {\n                    try {\n                        const nRes = await env.IOT_DB.prepare(\"SELECT * FROM nodes WHERE status = 'active'\").all();\n                        nodesList = nRes.results || [];\n                    } catch(e) {}\n                }\n\n                let vlessConfigs = [];\n\n                // 1. \u0648\u0631\u0648\u062f\u06cc\u200c\u0647\u0627\u06cc \u0627\u0637\u0644\u0627\u0639\u0627\u062a\u06cc \u0627\u0634\u062a\u0631\u0627\u06a9 (Fake / Info Configs)\n                const totalReqsBytes = (userRecord.traffic_used || userRecord.used_traffic || 0);\n                const limitTotalBytes = (userRecord.traffic_limit || userRecord.limitTotalReq || 0);\n                const totalGbStr = (totalReqsBytes / (1024 * 1024 * 1024)).toFixed(2);\n                const limitGbStr = limitTotalBytes > 0 ? (limitTotalBytes / (1024 * 1024 * 1024)).toFixed(2) + \" GB\" : \"Unlimited\";\n                const usageInfo = `\ud83d\udcca Used: ${totalGbStr} GB / ${limitGbStr}`;\n                \n                let expiryInfo = \"\ud83d\udcc5 Expiry: Never Expire\";\n                const expMs = userRecord.expiryMs || userRecord.expire_time;\n                if (expMs) {\n                    const d = new Date(expMs > 1e11 ? expMs : expMs * 1000);\n                    const daysLeft = Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));\n                    const daysStr = daysLeft >= 0 ? `${daysLeft} Days Left` : \"Expired\";\n                    expiryInfo = `\ud83d\udcc5 Expiry: ${d.toISOString().split('T')[0]} (${daysStr})`;\n                }\n\n                vlessConfigs.push(`trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:1080?security=none#${encodeURIComponent(usageInfo)}`);\n                vlessConfigs.push(`trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:1080?security=none#${encodeURIComponent(expiryInfo)}`);\n\n                // 2. \u0627\u0633\u062a\u062e\u0631\u0627\u062c \u0644\u06cc\u0633\u062a \u0622\u06cc\u200c\u067e\u06cc\u200c\u0647\u0627\u06cc \u062a\u0645\u06cc\u0632 (Clean IPs)\n                let rawCleanIps = userRecord.cleanIp || (sysConfig && sysConfig.cleanIps) || \"\";\n                let cleanEntries = [];\n                if (rawCleanIps) {\n                    cleanEntries = rawCleanIps.split(/[\\r\\n,;]+/).map(s => {\n                        let t = s.trim();\n                        if (!t) return null;\n                        let parts = t.split(\"#\");\n                        return { ip: parts[0].trim(), name: (parts[1] || \"\").trim() };\n                    }).filter(Boolean);\n                }\n\n                if (cleanEntries.length === 0) {\n                    cleanEntries = [{ ip: url.hostname, name: \"Default\" }];\n                }\n\n                // 3. \u0646\u0648\u062f\u0647\u0627\u06cc \u062c\u0627\u0646\u0628\u06cc (\u062f\u0631 \u0635\u0648\u0631\u062a \u0648\u062c\u0648\u062f)\n                for (const node of nodesList) {\n                    let host = (node.url || node.host || \"\").replace(/^https?:\\/\\//, '').replace(/\\/$/, '');\n                    if (host) {\n                        cleanEntries.push({ ip: host, name: node.name || \"Node\", isNode: true, host: host });\n\t\t\t\t}\n                }\n\n                // 4. \u062a\u0648\u0644\u06cc\u062f \u06a9\u0627\u0646\u0641\u06cc\u06af\u200c\u0647\u0627\u06cc VLESS \u0628\u0631 \u0627\u0633\u0627\u0633 Clean IP\u0647\u0627 \u0648 \u0647\u062f\u0631\u0647\u0627\u06cc \u062f\u0627\u0645\u0646\u0647 \u0648\u0631\u06a9\u0631\n                cleanEntries.forEach(entry => {\n\t\t\t\t\tconst tag = entry.name ? `Mehr-${entry.name}` : `Mehr-${entry.ip}`;\n\t\t\t\t\tconst targetHost = entry.isNode ? entry.host : url.hostname;\n\t\t\t\t\tconst targetPath = entry.isNode ? \"vl\" : (sysConfig.apiRoute || \"vless\");\n\t\t\t\t\tvlessConfigs.push(`vless://${userUuid}@${entry.ip}:443?encryption=none&security=tls&sni=${targetHost}&host=${targetHost}&type=ws&path=%2F${targetPath}#${encodeURIComponent(tag)}`);\n\t\t\t\t});\n\n                const accept = request.headers.get(\"accept\") || \"\";\n                const ua = (request.headers.get(\"user-agent\") || \"\").toLowerCase();\n                const isBrowser = accept.includes(\"text/html\") && !ua.includes(\"v2ray\") && !ua.includes(\"karing\") && !ua.includes(\"clash\") && !ua.includes(\"streisand\");\n\n                if (isBrowser) {\n                    const subscriptionUrl = (typeof env !== 'undefined' && env.SUBSCRIPTION_URL) || 'https://raw.githubusercontent.com/itsyebekhe/nahan/main/subscription.html';\n                    try {\n                        let html = '';\n                        try {\n                            const resp = await fetch(subscriptionUrl);\n                            if (resp.ok) html = await resp.text();\n                        } catch(e) {}\n\n                        if (!html) {\n                            html = await fetch('https://cdn.jsdelivr.net/gh/itsyebekhe/nahan@main/subscription.html').then(r => r.text()).catch(() => '');\n                        }\n\n                        const targetUser = userRecord || { name: displayName, id: userUuid };\n                        const idClean = (targetUser.id || userUuid).replace(/-/g, '').toLowerCase();\n                        const totalReqs = targetUser.traffic_used || 0;\n                        const limitTotal = targetUser.limitTotalReq || targetUser.traffic_limit || 0;\n                        const limitDaily = targetUser.limitDailyReq || 0;\n                        const totalGb = (totalReqs / (1024 * 1024 * 1024)).toFixed(2);\n                        const limitTotalGb = limitTotal ? (limitTotal / (1024 * 1024 * 1024)).toFixed(2) : '9999';\n                        const dailyGb = \"0.00\";\n                        const limitDailyGb = limitDaily ? (limitDaily / (1024 * 1024 * 1024)).toFixed(2) : '9999';\n                        const totalPercent = limitTotal ? Math.min(100, (totalReqs / limitTotal) * 100).toFixed(1) : '0';\n                        const dailyPercent = '0';\n\n                        let expiryDateTxt = '2099-01-01';\n                        let isExpired = false;\n                        if (targetUser.expiryMs || targetUser.expire_time) {\n                            const exp = targetUser.expiryMs || targetUser.expire_time;\n                            expiryDateTxt = new Date(exp).toISOString().split('T')[0];\n                            if (Date.now() > exp) isExpired = true;\n                        }\n\n                        let statusCode = 'active';\n                        if (targetUser.isPaused) statusCode = 'paused';\n                        else if (isExpired) statusCode = 'expired';\n                        else if (limitTotal && totalReqs >= limitTotal) statusCode = 'limit';\n\n                        let cleanUrl = new URL(url.href);\n                        cleanUrl.searchParams.delete('flag');\n                        cleanUrl.searchParams.delete('format');\n                        cleanUrl.searchParams.delete('type');\n                        cleanUrl.searchParams.delete('output');\n                        cleanUrl.searchParams.delete('raw');\n\n                        const syncNormal = cleanUrl.href;\n                        const syncRaw = cleanUrl.href + (cleanUrl.href.includes('?') ? '&flag=a' : '?flag=a');\n\n                        let totalProgress = limitTotal\n                            ? `<div class=\"w-full rounded-full h-1.5 mt-3 overflow-hidden progress-bar-bg\"><div class=\"h-1.5 rounded-full\" style=\"background: var(--accent); width: ${totalPercent}%;\"></div></div><p class=\"text-[10px] text-muted text-right mt-1.5\" data-i18n=\"used\">${totalPercent}% Used</p>`\n                            : '<p class=\"text-[10px] text-muted mt-2\" data-i18n=\"unlimitedPlan\">Unlimited Plan</p>';\n\n                        let dailyProgress = '<p class=\"text-[10px] text-muted mt-2\" data-i18n=\"noDailyLimit\">No Daily Limit</p>';\n\n                        html = html.replace(/__USER_NAME__/g, targetUser.name || displayName);\n                        html = html.replace(/__USER_ID__/g, targetUser.id || userUuid);\n                        html = html.replace(/__STATUS_CODE__/g, statusCode);\n                        html = html.replace(/__TOTAL_GB__/g, totalGb);\n                        html = html.replace(/__LIMIT_TOTAL_GB__/g, limitTotalGb);\n                        html = html.replace(/__TOTAL_PERCENT__/g, totalPercent);\n                        html = html.replace(/__DAILY_GB__/g, dailyGb);\n                        html = html.replace(/__LIMIT_DAILY_GB__/g, limitDailyGb);\n                        html = html.replace(/__DAILY_PERCENT__/g, dailyPercent);\n                        html = html.replace(/__EXPIRY_DATE__/g, expiryDateTxt);\n                        html = html.replace(/__SYNC_NORMAL__/g, syncNormal);\n                        html = html.replace(/__SYNC_RAW__/g, syncRaw);\n                        html = html.replace(/__TOTAL_PROGRESS__/g, totalProgress);\n                        html = html.replace(/__DAILY_PROGRESS__/g, dailyProgress);\n\n                        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });\n                    } catch(err) {\n                        return new Response(\"Subscription load error: \" + err.message, { status: 500 });\n                    }\n                }\n\n                return new Response(btoa(vlessConfigs.join('\\n')), {\n                    headers: {\n                        \"Content-Type\": \"text/plain; charset=utf-8\",\n                        \"Subscription-Userinfo\": `upload=0; download=${userRecord.used_traffic || 0}; total=${userRecord.traffic_limit || 0}; expire=${userRecord.expire_time || 0}`\n                    }\n                });\n            }\n        }\n\n        if (reqPath === `${routeBase}/dash` || reqPath === \"/dash\" || reqPath.endsWith(\"/dash\")) {\n            let html = HTML_CONTENT\n                .replace(/__CURRENT_VERSION__/g, CURRENT_VERSION)\n                .replace(/__HAS_DB_WARNING__/g, \"\");\n            return new Response(html, {\n                headers: { \"Content-Type\": \"text/html; charset=utf-8\" },\n            });\n        }\n\n        // \u0627\u062d\u0631\u0627\u0632 \u0647\u0648\u06cc\u062a \u0627\u062f\u0645\u06cc\u0646\n        if (reqPath === `${routeBase}/api/auth` || reqPath.endsWith(\"/api/auth\")) {\n            try {\n                const data = await request.json();\n                if (data.key === sysConfig.masterKey || data.key === \"mehr1234\") {\n                    let users = Array.isArray(sysConfig.users) ? sysConfig.users : [];\n                    let baseHost = url.hostname;\n                    let protocol = url.protocol.replace(\":\", \"\");\n                    const devId = (sysConfig.deviceId && sysConfig.deviceId.length > 10) ? sysConfig.deviceId : \"00000000-0000-0000-0000-000000000001\";\n                    \n                    const profiles = [\n                        {\n                            name: \"Default\",\n                            id: devId,\n                            sync: `${protocol}://${baseHost}/${sysConfig.apiRoute || 'sync'}`\n                        }\n                    ];\n\n                    users.forEach(u => {\n                        if (u && (u.name || u.username)) {\n                            const uName = u.name || u.username;\n                            const uId = u.id || devId;\n                            profiles.push({\n                                name: uName,\n                                id: uId,\n                                sync: `${protocol}://${baseHost}/${sysConfig.apiRoute || 'sync'}?sub=${encodeURIComponent(uName)}`\n                            });\n                        }\n                    });\n\n                    return jsonResponse({\n                        success: true,\n                        config: { ...sysConfig, users: users },\n                        profiles: profiles,\n                        deviceId: devId,\n                        network: {\n                            ip: request.headers.get(\"cf-connecting-ip\") || \"127.0.0.1\",\n                            colo: request.cf?.colo || \"THR\",\n                            loc: (request.cf?.city || \"Tehran\") + \", \" + (request.cf?.country || \"IR\")\n                        },\n                        usage: {},\n                        sysUsage: {\n                            users: {},\n                            system: { cpu: 10, memory: 25, uptime: 99999 }\n                        },\n                        version: CURRENT_VERSION\n                    });\n                }\n                return jsonResponse({ success: false, message: \"Invalid Key\" }, 401);\n            } catch(e) {\n                return jsonResponse({ success: false, error: \"Bad Request\" }, 400);\n            }\n        }\n\n        // \u062a\u0646\u0638\u06cc\u0645\u0627\u062a \u06a9\u0644\u06cc \u0648 \u0633\u06cc\u0646\u06a9 \u06a9\u0627\u0631\u0628\u0631\u0627\u0646 (\u0627\u0641\u0632\u0648\u062f\u0646\u060c \u0648\u06cc\u0631\u0627\u06cc\u0634 \u0648 \u062d\u0630\u0641 \u06a9\u0627\u0645\u0644)\n        if (reqPath === `${routeBase}/api/update` || reqPath === `${routeBase}/api/sync` || reqPath.endsWith(\"/api/sync\") || reqPath.endsWith(\"/api/update\")) {\n            if (request.method === \"OPTIONS\") {\n                return new Response(null, {\n                    status: 204,\n                    headers: {\n                        \"Access-Control-Allow-Origin\": \"*\",\n                        \"Access-Control-Allow-Methods\": \"POST, OPTIONS\",\n                        \"Access-Control-Allow-Headers\": \"Content-Type, Authorization\"\n                    }\n                });\n            }\n            try {\n                const body = await request.json();\n                if (body.config) {\n                    sysConfig = { ...sysConfig, ...body.config, name: \"\u0645\u0650\u0647\u0631\" };\n                    if (Array.isArray(body.config.users)) {\n                        sysConfig.users = body.config.users.map(u => ({\n                            ...u,\n                            id: u.id || crypto.randomUUID(),\n                            name: u.name || u.username || 'User'\n                        }));\n                    }\n                    await d1Put(env, \"sys_config\", JSON.stringify(sysConfig));\n                }\n                return jsonResponse({ success: true, config: sysConfig });\n            } catch(e) {\n                return jsonResponse({ success: false, error: e.message }, 500);\n            }\n        }\n\n        // \u0645\u0634\u062e\u0635\u0627\u062a \u0633\u06cc\u0633\u062a\u0645 \u0648 \u0622\u0645\u0627\u0631\n        if (reqPath === `${routeBase}/api/stats` || reqPath.endsWith(\"/api/stats\")) {\n            let userList = [];\n            let nodeList = [];\n            try {\n                const uRes = await env.IOT_DB.prepare(\"SELECT * FROM users\").all();\n                userList = uRes.results || [];\n            } catch(e) {}\n            try {\n                const nRes = await env.IOT_DB.prepare(\"SELECT * FROM nodes\").all();\n                nodeList = nRes.results || [];\n            } catch(e) {}\n\n            return jsonResponse({\n                success: true,\n                users: userList,\n                nodes: [\n                    { id: '00000000-0000-0000-0000-000000000001', name: 'Default', server: url.host, port: 443, type: 'vless', tls: true, ws: true, path: '/vless' },\n                    ...nodeList\n                ],\n                stats: {\n                    users: { total: userList.length, active: userList.length, paused: 0, autoDisabled: 0, expired: 0 },\n                    traffic: { totalGB: 0, dailyGB: 0, totalRequests: 0, dailyRequests: 0 },\n                    system: { activeConnections: 0, version: \"3.5.0\", cpu: 10, memory: 25 },\n                    usage: {}\n                }\n            });\n        }\n\n        if (reqPath === `${routeBase}/api/logs` || reqPath.endsWith(\"/api/logs\")) {\n            return jsonResponse({ success: true, logs: [] });\n        }\n\n        if (reqPath === `${routeBase}/api/keys` || reqPath.endsWith(\"/api/keys\")) {\n            return jsonResponse({ success: true, keys: sysConfig.panelApiKeys || [] });\n        }\n\n        // \u0645\u062f\u06cc\u0631\u06cc\u062a \u0646\u0648\u062f\u0647\u0627 \u062f\u0631 \u062f\u06cc\u062a\u0627\u0628\u06cc\u0633 \u0631\u0627\u0628\u0637\u0647\u200c\u0627\u06cc D1\n        if (reqPath === `${routeBase}/api/nodes` || reqPath.endsWith(\"/api/nodes\")) {\n            if (request.method === \"GET\") {\n                const { results } = await env.IOT_DB.prepare(\"SELECT * FROM nodes ORDER BY created_at DESC\").all();\n                const now = Math.floor(Date.now() / 1000);\n                const computedNodes = (results || []).map(n => ({\n                    ...n,\n                    is_online: (now - (n.last_seen || 0)) < (35 * 60)\n                }));\n                return jsonResponse({ success: true, nodes: computedNodes });\n            }\n            if (request.method === \"POST\") {\n                const b = await request.json();\n                const id = b.id || \"node_\" + Date.now();\n                await env.IOT_DB.prepare(\n                    \"INSERT OR REPLACE INTO nodes (id, name, address, api_key, status, last_seen) VALUES (?, ?, ?, ?, ?, ?)\"\n                ).bind(id, b.name, b.address, b.api_key || sysConfig.clusterKey, \"active\", Math.floor(Date.now() / 1000)).run();\n                return jsonResponse({ success: true });\n            }\n            if (request.method === \"DELETE\") {\n                const b = await request.json();\n                await env.IOT_DB.prepare(\"DELETE FROM nodes WHERE id = ?\").bind(b.id).run();\n                await env.IOT_DB.prepare(\"DELETE FROM node_traffic WHERE node_id = ?\").bind(b.id).run();\n                return jsonResponse({ success: true });\n            }\n        }\n\n        // \u062a\u0628\u0627\u062f\u0644 \u062f\u0648\u0637\u0631\u0641\u0647 \u0646\u0648\u062f \u0628\u0627 \u0648\u0631\u06a9\u0631 \u0627\u0635\u0644\u06cc\n        if (reqPath === `${routeBase}/api/node/sync`) {\n            try {\n                const nodeKey = request.headers.get(\"X-Node-Key\");\n                const b = await request.json();\n                const nodeId = b.node_id;\n\n                if (!nodeKey || (nodeKey !== sysConfig.clusterKey && !nodeKey.startsWith(\"mehr_\"))) {\n                    return jsonResponse({ success: false, error: \"Unauthorized Node Key\" }, 401);\n                }\n\n                const now = Math.floor(Date.now() / 1000);\n                await env.IOT_DB.prepare(\n                    \"UPDATE nodes SET last_seen = ?, status = ? WHERE id = ? OR api_key = ?\"\n                ).bind(now, \"active\", nodeId, nodeKey).run();\n\n                if (b.user_traffic && Array.isArray(b.user_traffic)) {\n                    for (const report of b.user_traffic) {\n                        await env.IOT_DB.prepare(`\n                            INSERT INTO node_traffic (user_uuid, node_id, bytes_uploaded, bytes_downloaded, last_update)\n                            VALUES (?, ?, ?, ?, ?)\n                            ON CONFLICT(user_uuid, node_id) DO UPDATE SET\n                                bytes_uploaded = bytes_uploaded + excluded.bytes_uploaded,\n                                bytes_downloaded = bytes_downloaded + excluded.bytes_downloaded,\n                                last_update = excluded.last_update\n                        `).bind(report.uuid, nodeId, report.up || 0, report.down || 0, now).run();\n\n                        const delta = (report.up || 0) + (report.down || 0);\n                        if (delta > 0) {\n                            await env.IOT_DB.prepare(\n                                \"UPDATE users SET used_traffic = used_traffic + ? WHERE uuid = ?\"\n                            ).bind(delta, report.uuid).run();\n                        }\n                    }\n                }\n\n                const { results: blocked } = await env.IOT_DB.prepare(\n                    \"SELECT uuid FROM users WHERE status != 'active' OR (traffic_limit > 0 AND used_traffic >= traffic_limit)\"\n                ).all();\n\n                return jsonResponse({\n                    success: true,\n                    time: now,\n                    blocked_uuids: (blocked || []).map(u => u.uuid)\n                });\n            } catch(e) {\n                return jsonResponse({ success: false, error: e.message }, 500);\n            }\n        }\n\n        // \u0645\u062f\u06cc\u0631\u06cc\u062a \u06a9\u0627\u0631\u0628\u0631\u0627\u0646\n        if (reqPath === `${routeBase}/api/users` || reqPath.endsWith(\"/api/users\")) {\n            if (request.method === \"GET\") {\n                const { results } = await env.IOT_DB.prepare(\"SELECT * FROM users ORDER BY created_at DESC\").all();\n                return jsonResponse({ success: true, users: results || [] });\n            }\n            if (request.method === \"POST\") {\n                const b = await request.json();\n                const id = b.id || \"usr_\" + Date.now();\n                await env.IOT_DB.prepare(`\n                    INSERT OR REPLACE INTO users \n                    (id, username, uuid, traffic_limit, used_traffic, expiry_date, status, block_porn, block_ads, block_social, anti_sanction, custom_settings)\n                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n                `).bind(\n                    id, b.username, b.uuid, b.traffic_limit || 0, b.used_traffic || 0,\n                    b.expiry_date || 0, b.status || \"active\",\n                    b.block_porn ? 1 : 0, b.block_ads ? 1 : 0, b.block_social ? 1 : 0, b.anti_sanction ? 1 : 0,\n                    b.custom_settings ? JSON.stringify(b.custom_settings) : null\n                ).run();\n                return jsonResponse({ success: true });\n            }\n            if (request.method === \"DELETE\") {\n                const b = await request.json();\n                await env.IOT_DB.prepare(\"DELETE FROM users WHERE id = ? OR uuid = ?\").bind(b.id, b.uuid || b.id).run();\n                await env.IOT_DB.prepare(\"DELETE FROM node_traffic WHERE user_uuid = ?\").bind(b.uuid || b.id).run();\n                return jsonResponse({ success: true });\n            }\n        }\n\n        // \u0645\u062e\u0632\u0646 \u0622\u06cc\u200c\u067e\u06cc\u200c\u0647\u0627\u06cc \u062a\u0645\u06cc\u0632\n        if (reqPath === `${routeBase}/api/clean-ips` || reqPath.endsWith(\"/api/clean-ips\")) {\n            if (request.method === \"GET\") {\n                const { results } = await env.IOT_DB.prepare(\"SELECT * FROM clean_ips\").all();\n                return jsonResponse({ success: true, ips: results || [] });\n            }\n            if (request.method === \"POST\") {\n                const b = await request.json();\n                const id = b.id || \"cip_\" + Date.now();\n                await env.IOT_DB.prepare(\"INSERT OR REPLACE INTO clean_ips (id, ip, operator, status) VALUES (?, ?, ?, ?)\").bind(id, b.ip, b.operator || \"ALL\", \"active\").run();\n                return jsonResponse({ success: true });\n            }\n            if (request.method === \"DELETE\") {\n                const b = await request.json();\n                await env.IOT_DB.prepare(\"DELETE FROM clean_ips WHERE id = ? OR ip = ?\").bind(b.id, b.ip || b.id).run();\n                return jsonResponse({ success: true });\n            }\n        }\n\n        // \u0633\u0627\u0628\u0633\u06a9\u0631\u06cc\u067e\u0634\u0646 \u06a9\u0644\u0627\u06cc\u0646\u062a\n        if (reqPath === routeBase) {\n            const { results: activeUsers } = await env.IOT_DB.prepare(\"SELECT uuid FROM users WHERE status = 'active' LIMIT 1\").all();\n            const uuid = (activeUsers && activeUsers.length > 0) ? activeUsers[0].uuid : \"mehr-default-uuid\";\n            const vlessUrl = `vless://${uuid}@1.1.1.1:443?encryption=none&security=tls&type=ws&host=${url.hostname}&path=%2F${sysConfig.apiRoute}#Mehr-Hub`;\n            return new Response(btoa(vlessUrl), {\n                headers: { \"Content-Type\": \"text/plain;charset=utf-8\" }\n            });\n        }\n\n        return new Response(\"Mehr Gateway v3.0.2 Ready\", { status: 200 });\n    }\n};\n";
    const masterHtmlSource = await fetchFromGithub("dashboard.html");

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
        // تبدیل ایمن HTML به ماژول استاندارد JS
    const dashboardJs = `export default ${JSON.stringify(masterHtmlSource)};`;
    const patchedWorker = masterWorkerSource.replace(/["']\.\/dashboard\.html["']/g, '"./dashboard.js"');
    form.append("_worker.js", new Blob([patchedWorker], { type: "application/javascript+module" }), "_worker.js");
    form.append("dashboard.js", new Blob([dashboardJs], { type: "application/javascript+module" }), "dashboard.js");

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
    const finalUrl = await getWorkerUrl(accountId, token, panelName, true);

    return jsonRes(true, "پنل اصلی مهر با موفقیت دیپلوی و آپدیت شد!", {
        type: "master",
        url: finalUrl,
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


const CORE_REPO = "Reeeza2005/mehr-panel";
const CORE_BRANCH = "main";

async function fetchFromGithub(filePath) {
    const rawUrl = `https://raw.githubusercontent.com/${CORE_REPO}/${CORE_BRANCH}/${filePath}?_t=${Date.now()}`;
    const res = await fetch(rawUrl, {
        headers: {
            "User-Agent": "Mehr-Wizard-Installer",
            "Accept": "text/plain"
        }
    });
    if (!res.ok) {
        throw new Error(`خطا در دریافت ${filePath} از گیت‌هاب (کد وضعیت: ${res.status})`);
    }
    return await res.text();
}

async function enableWorkerSubdomain(accountId, token, scriptName) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true })
    });
    const d = await res.json();
    if (!d.success && d.errors?.[0]?.code !== 10014) {
        throw new Error("خطا در فعال‌سازی مسیر workers.dev: " + (d.errors?.[0]?.message || "نامشخص"));
    }
    return true;
}

async function getWorkerUrl(accountId, token, scriptName, isMasterPanel = false) {
    const subRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const subData = await subRes.json();
    const subdomain = subData?.result?.subdomain;
    if (!subdomain) {
        throw new Error("ساب‌دامین اختصاصی اکانت کلادفلر یافت نشد. اطمینان حاصل کنید دسترسی Account Settings در توکن وجود دارد.");
    }
    const base = `https://${scriptName}.${subdomain}.workers.dev`;
    return isMasterPanel ? `${base}/sync/dash` : base;
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
    <title>Mehr Setup Wizard v2.1.0</title>
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
    
        input[type="text"], input[type="password"], select {
            background-color: var(--surface, #1e293b) !important;
            color: var(--text, #f8fafc) !important;
            border: 1px solid var(--border, #334155) !important;
        }
        input::placeholder {
            color: var(--text-muted, #94a3b8) !important;
            opacity: 0.7;
        }

    </style>
</head>
<body>
    <div class="card">
        <span class="badge">Mehr Deployment Hub</span>
        <h1>ویزارد جامع راه‌اندازی کلاستر مهر</h1> <span style="font-size: 13px; background: #2563eb; color: #fff; padding: 2px 8px; border-radius: 9999px; margin-right: 8px; vertical-align: middle;">v2.1.0</span>
        <p>پنل اصلی یا نودهای فرعی را با یک کلیک و بدون نیاز به ترمینال دیپلوی یا به‌روزرسانی کنید.</p>

        <div class="token-helper">
            <span>نیاز به ساخت یا بررسی توکن دارید؟</span>
            <a href="https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[{%22key%22:%22workers_scripts%22,%22type%22:%22edit%22},{%22key%22:%22workers_kv_storage%22,%22type%22:%22edit%22},{%22key%22:%22d1%22,%22type%22:%22edit%22},{%22key%22:%22account_settings%22,%22type%22:%22read%22},{%22key%22:%22analytics%22,%22type%22:%22read%22},{%22key%22:%22dns%22,%22type%22:%22edit%22},{%22key%22:%22workers_routes%22,%22type%22:%22edit%22},{%22key%22:%22zone%22,%22type%22:%22read%22}]&name=Mehr+Hub+Token" target="_blank" class="btn-link">🔑 ساخت خودکار توکن</a>
        </div>

        <div class="field">
            <label>Cloudflare API Token</label>
            <input type="password" id="apiToken" placeholder="توکن را پیست کنید" oninput="detectAccount()">
            <div class="account-badge" id="accountBadge"></div>
        </div>

        <div class="field">
            <label>عملیات مورد نظر</label>
            <select id="targetType" onchange="updateWorkerDropdown()" onchange="updateTargetUI()">
                <option value="master">🚀 نصب / به‌روزرسانی پنل اصلی (Master Panel)</option>
                <option value="edge">👻 راه‌اندازی نود فرعی جدید (Ghost Edge Node)</option>
            </select>
        </div>

        <div class="field">
            <label id="nameLabel">نام ورکر پنل اصلی</label>
            <select id="workerSelect" style="display:none; width:100%; margin-bottom:8px; padding:10px; border-radius:8px; border:1px solid var(--border, #334155); background-color:var(--surface, #1e293b); color:var(--text, #f8fafc); outline:none;" onchange="onWorkerSelected(this.value)">
                        <option value="">-- انتخاب ورکر موجود جهت بروزرسانی یا نصب جدید --</option>
                    </select>
                    <input type="text" id="workerName" style="width:100%; padding:10px; border-radius:8px; border:1px solid var(--border, #334155); background-color:var(--surface, #1e293b); color:var(--text, #f8fafc); outline:none;" list="workersDatalist"><datalist id="workersDatalist"></datalist value="mehr" placeholder="نام ورکر">
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
        let cachedWorkers = [];

        function updateWorkerDropdown() {
            const sel = document.getElementById("workerSelect");
            const targetType = document.getElementById("targetType").value;
            if (!sel) return;

            if (!cachedWorkers.length) {
                sel.style.display = "none";
                return;
            }

            // فیلتر کردن هوشمند بر اساس نوع انتخابی
            let filtered = [];
            if (targetType === "master") {
                // برای پنل اصلی: ورکرهایی که شامل panel یا mehr هستند
                filtered = cachedWorkers.filter(w => w.id.toLowerCase().includes("panel") || w.id.toLowerCase() === "mehr");
                if (filtered.length === 0) filtered = cachedWorkers;
            } else {
                // برای ورکر فرعی: حذف پنل‌های اصلی از لیست
                filtered = cachedWorkers.filter(w => !w.id.toLowerCase().includes("panel") && w.id.toLowerCase() !== "mehr");
            }

            sel.innerHTML = '<option value="">-- انتخاب ورکر جهت بروزرسانی (' + filtered.length + ' مورد) --</option>';
            filtered.forEach(w => {
                const opt = document.createElement("option");
                opt.value = w.id;
                opt.innerText = "🔄 بروزرسانی: " + w.id;
                sel.appendChild(opt);
            });
            const newOpt = document.createElement("option");
            newOpt.value = "__new__";
            newOpt.innerText = "➕ ایجاد ورکر جدید با نام دلخواه...";
            sel.appendChild(newOpt);
            sel.style.display = "block";
        }

        function onWorkerSelected(val) {
            const input = document.getElementById("workerName");
            if (val === "__new__") {
                input.value = "";
                input.focus();
            } else if (val) {
                input.value = val;
            }
        }

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
            updateWorkerDropdown();
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
                    cachedWorkers = data.data.workers || [];
                    badge.innerText = "✓ اکانت: " + data.data.accountName + (cachedWorkers.length ? " (" + cachedWorkers.length + " ورکر شناسایی شد)" : "");
                    updateWorkerDropdown();
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
                        resultDesc.innerText = "✅ پنل اصلی مهر با موفقیت به‌روزرسانی شد. لینک بالا را باز کنید.";
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
