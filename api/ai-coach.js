// Ambition CBT Mode 2.0 — AI Backend (Multi-Model Auto-Discovery + Groq Failover)
// Powered by ASVIRO STUDIO
'use strict';

const http = require('../lib/http');
const session = require('../lib/session');

const MAX_MESSAGE_CHARS = 60000;
const MAX_CONTEXT_CHARS = 60000;
const MAX_IMAGES = 10;
const MAX_IMAGE_B64 = 6 * 1024 * 1024; // ~4.5 MB decoded

// Cache discovered models per warm serverless instance
let cachedModels = null;

async function fetchGemini(model, key, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    const cleanModel = model.replace(/^models\//, '');
    return await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(cleanModel) + ':generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function getLiveGeminiModels(key) {
  if (cachedModels && cachedModels.length > 0) return cachedModels;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': key }
    });
    if (!r.ok) return [];
    const data = await r.json();
    const list = (data && Array.isArray(data.models)) ? data.models : [];
    const valid = list
      .filter(function (m) {
        return m && m.name && Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.indexOf('generateContent') !== -1 &&
          /gemini/i.test(m.name) &&
          !/embedding|imagen|aqa|tts|audio|robotics|computer-use|veo|learnlm/i.test(m.name);
      })
      .map(function (m) { return m.name.replace(/^models\//, ''); });

    // Prioritize Flash models first for speed & high quota
    valid.sort(function (a, b) {
      const score = function (name) {
        if (/gemini-3.*flash/i.test(name)) return 1;
        if (/gemini-2\.5-flash/i.test(name)) return 2;
        if (/flash/i.test(name)) return 3;
        if (/pro/i.test(name)) return 4;
        return 5;
      };
      return score(a) - score(b);
    });

    if (valid.length > 0) cachedModels = valid.slice(0, 5);
    return cachedModels || [];
  } catch (e) {
    return [];
  }
}

async function fetchGroqFallback(groqKey, system, message, isCBT, hasImages, allImages) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 20000);
  try {
    const model = hasImages ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'llama-3.3-70b-versatile';
    const userContent = hasImages
      ? [{ type: 'text', text: message }].concat(allImages.slice(0, 4).map(function (img) {
          return { type: 'image_url', image_url: { url: 'data:' + img.mime + ';base64,' + img.data } };
        }))
      : message;

    const payload = {
      model: model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent }
      ],
      temperature: isCBT ? 0.15 : 0.7,
      max_tokens: 6000
    };

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + groqKey
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await r.json().catch(function () { return {}; });
    if (r.ok && data.choices && data.choices[0] && data.choices[0].message) {
      return { ok: true, text: (data.choices[0].message.content || '').trim() };
    }
    return { ok: false, err: 'Groq:' + r.status };
  } catch (e) {
    return { ok: false, err: 'Groq:Err' };
  } finally {
    clearTimeout(timer);
  }
}

function isSafeImage(img) {
  if (!img || typeof img !== 'object') return false;
  if (typeof img.data !== 'string' || typeof img.mime !== 'string') return false;
  const cleanData = img.data.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').trim();
  if (cleanData.length === 0 || cleanData.length > MAX_IMAGE_B64) return false;
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(img.mime)) return false;
  img.data = cleanData;
  img.mime = img.mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : img.mime.toLowerCase();
  return /^[A-Za-z0-9+/=\r\n]+$/.test(cleanData.slice(0, 200));
}

function cleanCBTJson(text) {
  let clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const fb = clean.indexOf('[');
  const lb = clean.lastIndexOf(']');
  if (fb >= 0 && lb > fb) clean = clean.slice(fb, lb + 1);
  return clean;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return http.methodNotAllowed(res, ['POST']);

  let authed = null;
  try {
    authed = session.verify(http.parseCookies(req.headers.cookie)[http.COOKIE_NAME]);
  } catch (e) {
    return http.json(res, 500, { error: 'SERVER_CONFIG', message: 'Session secret not configured.' });
  }
  if (!authed) return http.json(res, 401, { error: 'UNAUTHORIZED' });

  const reply = function (text) { return http.json(res, 200, { message: text }); };

  const body = http.parseBody(req);
  if (!body) return http.json(res, 400, { error: 'BAD_BODY' });

  const { message, context, history } = body;
  if (!message || typeof message !== 'string' || message.length > MAX_MESSAGE_CHARS) {
    return http.json(res, 400, { error: 'BAD_INPUT', message: 'Message missing or too long.' });
  }

  const key = (process.env.GEMINI_API_KEY || '').trim();
  const groqKey = (process.env.GROQ_API_KEY || '').trim();

  if (!key && !groqKey) {
    return http.json(res, 500, { error: 'NO_KEY', message: 'Add GEMINI_API_KEY or GROQ_API_KEY in Vercel.' });
  }

  const ctx = (context && typeof context === 'object' && !Array.isArray(context)) ? context : {};
  const ctxJson = JSON.stringify(ctx);
  if (ctxJson.length > MAX_CONTEXT_CHARS) {
    return http.json(res, 413, { error: 'CONTEXT_TOO_LARGE' });
  }

  const mode = typeof ctx.mode === 'string' ? ctx.mode : 'chat';
  const isExtractMode = (mode === 'scanned-extract' || mode === 'image-extract' || mode === 'extract' || mode === 'notes' || mode === 'ai');
  const isCBT = ctx.source === 'cbt-test-studio' || ctx.source === 'ambition-cuet-cbt' || isExtractMode;

  let allImages = [];
  const rawImages = Array.isArray(body.images) ? body.images : (body.image ? [body.image] : []);
  allImages = rawImages.filter(isSafeImage).slice(0, MAX_IMAGES);
  const hasImages = allImages.length > 0;

  let system = '';

  const mathRule =
    '7. CRITICAL MATH RULE: Wrap ALL math expressions and formulas (in both "q" and every item in "options") inside `$ ... $` delimiters (e.g. "$-x \\\\cos^{-1} x + \\\\sqrt{1 - x^2} + C$"). Do NOT leave raw LaTeX outside `$ ... $`. Inside JSON strings, ALWAYS escape backslashes as `\\\\` (e.g. `\\\\frac`, `\\\\sqrt`, `\\\\tan`, `\\\\cos`).\n\n';

  if (hasImages && (mode === 'scanned-extract' || mode === 'image-extract' || mode === 'extract' || mode === 'notes')) {
    system =
      'You are an expert Indian exam question extractor.\n\n' +
      'MISSION: Extract ALL valid exam questions from the image and convert to standard 4-option MCQ format.\n\n' +
      'CRITICAL RULES:\n' +
      '1. Extract questions that are ACTUALLY PRESENT in the image. Do NOT invent questions from different subjects.\n' +
      '2. If the image is blurry, try your best to read it. ONLY return [] if the image has absolutely no text/questions.\n' +
      '3. Question text must be EXACT. If it has statements (A, B, C, D), put EACH statement on a NEW LINE using \\n.\n' +
      '4. REMOVE all option prefixes from the options array! Do NOT include (a), (b), (A), 1, 2. Just the raw text.\n' +
      '5. Exactly 4 options, ONE correct. "ans" = 0-based index (0,1,2,3).\n' +
      '6. If direct question without options, SOLVE carefully. Only 1 option must be 100% correct.\n' +
      mathRule +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["text1","text2","text3","text4"],"ans":0,"topic":"...","diff":"easy","explain":""}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(ctx);

  } else if (isCBT && mode === 'extract') {
    system =
      'You are an expert CUET exam question extractor.\n\n' +
      'CRITICAL RULES:\n' +
      '1. Extract ONLY the questions present in the text.\n' +
      '2. If the text doesn\'t have questions, return [].\n' +
      '3. Question text EXACT. Statements (A, B, C, D) on new lines using \\n.\n' +
      '4. REMOVE option prefixes (a), (b), (A), 1. from the array items.\n' +
      '5. Exactly 4 options, ONE correct. "ans" = 0 to 3.\n' +
      mathRule +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["text1","text2","text3","text4"],"ans":0,"topic":"...","diff":"easy","explain":""}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(ctx);

  } else if (isCBT && mode === 'notes') {
    system =
      'You are a senior CUET UG paper setter.\n' +
      'Generate high-yield NCERT MCQs. 4 options, 1 correct. REMOVE any prefixes from options array.\n' +
      mathRule +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["text1","text2","text3","text4"],"ans":0,"topic":"...","diff":"easy","explain":""}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(ctx);

  } else if (isCBT && mode === 'ai') {
    system =
      'You are an expert CUET UG paper setter. Generate MCQs matching Oswaal/Arihant style.\n' +
      '4 options, 1 correct. REMOVE any prefixes from options array.\n' +
      mathRule +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["text1","text2","text3","text4"],"ans":0,"topic":"...","diff":"easy","explain":""}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(ctx);

  } else {
    system = 'You are "The Raven", a wise and encouraging AI coach for competitive exam students. Supportive, concise.\n\n' +
      'USER REQUEST:\n' + JSON.stringify(ctx) + '\n\nUser Message: ' + message;
  }

  let msgs = (Array.isArray(history) ? history : [])
    .slice(-10)
    .filter(function (m) {
      return m && (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' && m.content.length > 0 && m.content.length < 8000;
    });
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) msgs = [{ role: 'user', content: message }];

  const contents = msgs.map(function (m) {
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    };
  });

  if (hasImages) {
    const lastMsg = contents[contents.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      for (let i = 0; i < allImages.length; i++) {
        lastMsg.parts.push({
          inlineData: { mimeType: allImages[i].mime, data: allImages[i].data }
        });
      }
    }
  }

  const errors = [];
  let sawQuota = false;
  let authError = '';

  if (key) {
    // 1. Query Google directly for whatever models are active on this key right now
    const liveModels = await getLiveGeminiModels(key);
    const fallbackList = [
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-2.5-flash',
      'gemini-2.0-flash'
    ];
    const models = liveModels.length > 0 ? liveModels : fallbackList;

    if (liveModels.length === 0) {
      errors.push('NoLiveModels');
    }

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      try {
        const genConfig = { maxOutputTokens: 8192, temperature: isCBT ? 0.15 : 0.85 };
        if (isCBT) genConfig.responseMimeType = 'application/json';

        const r = await fetchGemini(model, key, {
          systemInstruction: { parts: [{ text: system }] },
          contents: contents,
          generationConfig: genConfig
        }, 18000);

        const data = await r.json().catch(function () { return {}; });

        if (r.ok) {
          const parts = data.candidates && data.candidates[0] &&
            data.candidates[0].content && data.candidates[0].content.parts;
          let text = parts ? parts.map(function (p) { return p.text || ''; }).join('').trim() : '';
          if (text) {
            if (isCBT) text = cleanCBTJson(text);
            return reply(text);
          }
          errors.push(model + ':Empty');
          continue;
        }

        const msg = (data.error && data.error.message) || ('HTTP ' + r.status);
        errors.push(model + ':' + r.status);

        if (r.status === 401 || r.status === 403 || (r.status === 400 && /API_KEY_INVALID|key not valid/i.test(msg))) {
          authError = msg.slice(0, 50);
          break;
        }
        if (r.status === 429) { sawQuota = true; continue; }

      } catch (e) {
        errors.push(model + ':' + (e.name === 'AbortError' ? 'Timeout' : 'NetErr'));
      }
    }
  }

  // 2. Automatic Failover to Groq if Gemini failed and GROQ_API_KEY is configured
  if (groqKey) {
    const gRes = await fetchGroqFallback(groqKey, system, message, isCBT, hasImages, allImages);
    if (gRes.ok && gRes.text) {
      return reply(isCBT ? cleanCBTJson(gRes.text) : gRes.text);
    }
    errors.push(gRes.err);
  }

  const errSummary = errors.slice(0, 3).join(' | ');
  console.error('[ai-coach] failed:', errSummary);
  if (authError) return http.json(res, 401, { error: 'AUTH_ERROR', message: 'Invalid Key: ' + authError });
  if (sawQuota) return http.json(res, 429, { error: 'QUOTA_EXCEEDED', message: 'Quota hit (' + errSummary + ')' });
  return http.json(res, 502, { error: 'AI_UNAVAILABLE', message: errSummary });
};

module.exports.config = { maxDuration: 60 };
