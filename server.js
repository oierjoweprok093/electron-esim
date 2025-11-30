const path = require("path");
const express = require("express");
const cors = require("cors");
const gsmarena = require("gsmarena-api");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
const publicDir = path.join(__dirname, "public");
app.use(
  express.static(publicDir, {
    index: "index.html",
  })
);

// Simple in-memory cache to avoid repeating the same lookups.
const cache = new Map();

// Throttle and circuit-breaker to protect the upstream source.
let lastCallTs = 0;
const MIN_INTERVAL_MS = 5000; // 5 seconds between upstream calls
let remoteBlockedUntil = 0; // when > now, skip calling upstream (after 429)

async function safeSearchDevices(query) {
  if (Date.now() < remoteBlockedUntil) {
    const err = new Error("UPSTREAM_BLOCKED");
    err.code = "UPSTREAM_BLOCKED";
    throw err;
  }
  const results = await gsmarena.search.search(query);
  if (!results || !Array.isArray(results)) return [];
  return results;
}

function normalizeCacheKey(query, deviceId) {
  if (deviceId) return `id:${deviceId}`;
  return `q:${(query || "").trim().toLowerCase()}`;
}

function mapDeviceResult(device) {
  if (!device) return null;
  return {
    id: device.id,
    name: device.name,
    image: device.thumbnail || null,
    brand: device.brand || null,
  };
}

// Search endpoint (manual search suggestions)
app.post("/api/search-devices", async (req, res) => {
  try {
    const { query } = req.body || {};

    if (!query || !query.trim()) {
      return res.status(400).json({ error: "اكتب اسم الجهاز للبحث عنه." });
    }

    // Local throttle
    const now = Date.now();
    if (now - lastCallTs < MIN_INTERVAL_MS) {
      return res.status(429).json({
        error: "تم إيقاف الطلب مؤقتاً لتفادي الحظر. انتظر ثوانٍ ثم أعد المحاولة.",
        code: "LOCAL_THROTTLE",
      });
    }
    if (now < remoteBlockedUntil) {
      return res.status(429).json({
        error: "المصدر حظر الطلبات سابقاً (429). انتظر قليلاً ثم حاول مجدداً.",
        code: "UPSTREAM_BLOCKED",
      });
    }
    lastCallTs = now;

    const cleanQuery = query.trim();
    const results = await safeSearchDevices(cleanQuery);

    return res.json({
      results: results.slice(0, 8).map(mapDeviceResult).filter(Boolean),
    });
  } catch (err) {
    console.error("Search error:", err);

    if ((err.response && err.response.status === 429) || err.code === "UPSTREAM_BLOCKED") {
      remoteBlockedUntil = Date.now() + 30000; // 30s cooldown
      return res.status(429).json({
        error: "المصدر حظر الطلبات لكثرتها (429). انتظر نصف دقيقة ثم حاول مرة أخرى.",
        code: 429,
      });
    }

    return res.status(500).json({
      error: "حدث خطأ أثناء معالجة البحث.",
      details: err.message,
    });
  }
});

// Check eSIM support endpoint
app.post("/api/check-esim", async (req, res) => {
  try {
    const { query, deviceId } = req.body || {};

    if ((!query || !query.trim()) && !deviceId) {
      return res
        .status(400)
        .json({ error: "اكتب اسم الجهاز أو اختره من الاقتراحات." });
    }

    const cleanQuery = query ? query.trim() : null;
    const cacheKey = normalizeCacheKey(cleanQuery, deviceId);

    // Cache hit
    if (cache.has(cacheKey)) {
      return res.json({ ...cache.get(cacheKey), fromCache: true });
    }

    // Local throttle
    const now = Date.now();
    if (now - lastCallTs < MIN_INTERVAL_MS) {
      return res.status(429).json({
        error: "تم إيقاف الطلب مؤقتاً لتفادي الحظر. انتظر ثوانٍ ثم أعد المحاولة.",
        code: "LOCAL_THROTTLE",
      });
    }
    if (now < remoteBlockedUntil) {
      return res.status(429).json({
        error: "المصدر حظر الطلبات سابقاً (429). انتظر قليلاً ثم حاول مرة أخرى.",
        code: "UPSTREAM_BLOCKED",
      });
    }
    lastCallTs = now;

    let selectedId = deviceId;
    let firstResult = null;

    // If no deviceId, search first
    if (!selectedId) {
      const results = await safeSearchDevices(cleanQuery);

      if (!results || results.length === 0) {
        const payload = {
          found: false,
          message: "لم نجد جهازاً مطابقاً. جرّب كتابة الاسم بشكل أدق.",
        };
        cache.set(cacheKey, payload);
        return res.json(payload);
      }

      firstResult = results[0];
      selectedId = firstResult.id;
    }

    // Get device details
    const device = await gsmarena.catalog.getDevice(selectedId);

    let simText = null;

    if (Array.isArray(device.detailSpec)) {
      for (const section of device.detailSpec) {
        if (!section || !Array.isArray(section.specifications)) continue;

        for (const spec of section.specifications) {
          if (!spec || !spec.name || !spec.value) continue;

          if (spec.name.toLowerCase().includes("sim")) {
            if (Array.isArray(spec.value)) {
              simText = spec.value.join(" | ");
            } else {
              simText = String(spec.value);
            }
          }
        }
      }
    }

    if (!simText) {
      const payload = {
        found: true,
        deviceName: device.name || (firstResult && firstResult.name) || query,
        deviceId: selectedId,
        simRaw: null,
        supportsEsim: null,
        message:
          "لم نعثر على تفاصيل الشريحة لهذا الجهاز. قد تحتاج للتأكد يدوياً أو من دليل الجهاز.",
      };
      cache.set(cacheKey, payload);
      return res.json(payload);
    }

    const supportsEsim = simText.toLowerCase().includes("esim");

    const payload = {
      found: true,
      deviceName: device.name || (firstResult && firstResult.name) || query,
      deviceId: selectedId,
      simRaw: simText,
      supportsEsim,
      message: supportsEsim
        ? "هذا الجهاز يدعم شريحة eSIM بحسب تفاصيل الشرائح."
        : "لم نجد ما يثبت دعم eSIM في مواصفات هذا الجهاز.",
    };

    cache.set(cacheKey, payload);

    return res.json(payload);
  } catch (err) {
    console.error("Server error:", err);

    if ((err.response && err.response.status === 429) || err.code === "UPSTREAM_BLOCKED") {
      remoteBlockedUntil = Date.now() + 30000; // 30s cooldown
      return res.status(429).json({
        error: "المصدر حظر الطلبات لكثرتها (429). انتظر نصف دقيقة ثم حاول مرة أخرى.",
        code: 429,
      });
    }

    return res.status(500).json({
      error: "حدث خطأ أثناء معالجة الطلب.",
      details: err.message,
    });
  }
});

// Serve the frontend for any GET (fallback)
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Electron eSIM server running on http://localhost:${PORT}`);
});
