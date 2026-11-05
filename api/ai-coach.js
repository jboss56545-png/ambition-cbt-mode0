// Ambition CBT Mode 2.0 — AI Backend (Dynamic Model Discovery + Groq Failover + Auto Shuffle)
// Powered by ASVIRO STUDIO
'use strict';

const http = require('../lib/http');
const session = require('../lib/session');

const MAX_MESSAGE_CHARS = 60000;
const MAX_CONTEXT_CHARS = 60000;
const MAX_IMAGES = 10;
const MAX_IMAGE_B64 = 6 * 1024 * 1024;

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

async function fetchGroqFallback(groqKey, system, userMsg, isCBT, hasImages, allImages) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 25000);
  try {
    const model = hasImages ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'llama-3.3-70b-versatile';
    const userContent = hasImages
      ? [{ type: 'text', text: userMsg }].concat(allImages.slice(0, 4).map(function (img) {
          return { type: 'image_url', image_url: { url: 'data:' + img.mime + ';base64,' + img.data } };
        }))
      : userMsg;

    const payload = {
      model: model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent }
      ],
      temperature: isCBT ? 0.15 : 0.7,
      max_tokens: 8192,
      ...(isCBT && !hasImages && { response_format: { type: 'json_object' } })
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
  if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(img.mime)) return false;
  img.data = cleanData;
  img.mime = img.mime.toLowerCase().replace(/^image\/jpg$/, 'image/jpeg');
  return /^[A-Za-z0-9+/=\r\n]+$/.test(cleanData.slice(0, 200));
}

function cleanCBTJson(text) {
  let clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const fb = clean.indexOf('[');
  const lb = clean.lastIndexOf(']');
  if (fb >= 0 && lb > fb) clean = clean.slice(fb, lb + 1);
  return clean;
}

function isJsonComplete(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[' || text[i] === '{') depth++;
    else if (text[i] === ']' || text[i] === '}') depth--;
  }
  return depth === 0;
}

// 🔥 MAGIC FUNCTION: AI generates perfect distinct options, then this code shuffles them!
function shuffleAnswers(jsonString) {
  try {
    let arr = JSON.parse(jsonString);
    if (!Array.isArray(arr)) return jsonString;
    
    for (let item of arr) {
      if (!item.options || item.options.length < 2) continue;
      
      let correctIdx = item.ans || 0;
      let correctOpt = item.options[correctIdx];
      
      // Get the 3 incorrect options
      let otherOpts = item.options.filter((_, i) => i !== correctIdx);
      
      // Shuffle the incorrect options
      for (let i = otherOpts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [otherOpts[i], otherOpts[j]] = [otherOpts[j], otherOpts[i]];
      }
      
      // Insert the correct option at a random position
      let newAnsIndex = Math.floor(Math.random() * (otherOpts.length + 1));
      otherOpts.splice(newAnsIndex, 0, correctOpt);
      
      // Update the item
      item.options = otherOpts;
      item.ans = newAnsIndex;
    }
    return JSON.stringify(arr);
  } catch (e) {
    return jsonString; // If parsing fails, return original
  }
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
  const isCBT = ctx.source === 'cbt-test-studio' || ctx.source === 'ambition-cuet-cbt' ||
    ['scanned-extract', 'image-extract', 'extract', 'notes', 'ai'].indexOf(mode) !== -1;

  let allImages = [];
  const rawImages = Array.isArray(body.images) ? body.images : (body.image ? [body.image] : []);
  allImages = rawImages.filter(isSafeImage).slice(0, MAX_IMAGES);
  const hasImages = allImages.length > 0;

  let system = '';

  const mathRule =
    'MATH RULE: Wrap ALL math in `$ ... $` delimiters. Inside JSON strings, ALWAYS escape backslashes as `\\\\` (e.g. `\\\\frac`, `\\\\sqrt`).\n\n';

  const noDupRule = 'DUPLICATE RULE: Before returning, check for duplicate questions. Keep only the first occurrence. Also, ensure all 4 options for a question are completely DISTINCT and not identical.\n\n';

  const compactRule = 'COMPACT RULE: Set "explain" to empty string "" to save space. This is CRITICAL so all questions fit in the output.\n\n';

  // 🔥 REVERTED: Simple, clear instruction to put correct answer at Index 0. Code will shuffle it later.
  const strictAnsRule = 'ANSWER RULE: Always put the CORRECT option at index 0 in the options array (i.e., "ans": 0). The other 3 options must be distinct incorrect distractors. Do NOT shuffle options yourself.\n\n';

  if (mode === 'notes') {
    if (hasImages) {
      system =
        'You are a senior CUET UG paper setter.\n' +
        'The image contains STUDY NOTES. Your job is to GENERATE high-quality MCQs FROM these notes.\n\n' +
        'RULES:\n' +
        '1. GENERATE new CUET-style MCQs based on the concepts.\n' +
        '2. 4 options per question, only 1 correct.\n' +
        noDupRule + mathRule + compactRule + strictAnsRule +
        'FORMAT — Reply with ONLY a valid JSON array:\n' +
        '[{"q":"...","options":["...","...","...","..."],"ans":0,"topic":"...","diff":"easy","explain":""}]\n\n' +
        'USER REQUEST:\n' + JSON.stringify(ctx);
    } else {
      system =
        'You are a senior CUET UG paper setter.\n' +
        'Generate high-yield NCERT MCQs from these notes.\n' +
        noDupRule + mathRule + compactRule + strictAnsRule +
        'FORMAT — Reply with ONLY a valid JSON array:\n' +
        '[{"q":"...","options":["...","...","...","..."],"ans":0,"topic":"...","diff":"easy","explain":""}]\n\n' +
        'USER REQUEST:\n' + JSON.stringify(ctx);
    }

  } else if (hasImages && mode === 'image-extract') {
    system =
      'You are an expert Indian exam question extractor. This is a PHOTO of a question paper.\n\n' +
      'MISSION: Extract EVERY SINGLE question visible in this photo.\n\n' +
      'CRITICAL RULES:\n' +
      '1. FIRST: silently COUNT all questions you can see. There may be 20, 30, or more.\n' +
      '2. THEN: extract ALL of them, every single one. Do NOT skip any.\n' +
      '3. If a question has statements, put each on a NEW LINE using \\n.\n' +
      '4. REMOVE all option prefixes from options array.\n' +
      '5. Exactly 4 options, ONE correct.\n' +
      '6. If direct question without options, SOLVE carefully and create 4 options.\n' +
      noDupRule + mathRule + compactRule + strictAnsRule +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["...","...","...","..."],"ans":0,"topic":"...","diff":"easy","explain":""}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(ctx);

  } else if (hasImages && mode === 'scanned-extract') {
    system =
      'You are an expert exam question extractor. This is a SCANNED PAGE from a PDF.\n\n' +
      'MISSION: Extract EVERY SINGLE question on this page.\n\n' +
      'CRITICAL RULES:\n' +
      '1. FIRST: silently COUNT all numbered questions.\n' +
      '2. THEN: extract ALL of them. Do NOT skip any.\n' +
      '3. REMOVE all option prefixes.\n' +
      '4. Exactly 4 options, ONE correct.\n' +
      '5. If direct question without options, SOLVE and create 4 options.\n' +
      noDupRule + mathRule + compactRule + strictAnsRule +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["...","...","...","..."],"ans":0,"topic":"...","diff":"easy","explain":""}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(ctx);

  } else if (isCBT && mode === 'extract') {
    system =
      'You are an expert CUET exam question extractor.\n\n' +
      'CRITICAL RULES:\n' +
      '1. Extract ONLY the questions present in the text. Do NOT invent.\n' +
      '2. If no questions found, return [].\n' +
      '3. Exactly 4 options, ONE correct.\n' +
      '4. If direct question without options, SOLVE and create 4 options.\n' +
      noDupRule + mathRule + compactRule + strictAnsRule +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["...","...","...","..."],"ans":0,"topic":"...","diff":"easy","explain":""}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(ctx);

  } else if (isCBT && mode === 'ai') {
    system =
      'You are an expert CUET UG paper setter. Generate MCQs matching Oswaal/Arihant style.\n' +
      '4 options, 1 correct. Remove any prefixes from options array.\n' +
      noDupRule + mathRule + compactRule + strictAnsRule +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["...","...","...","..."],"ans":0,"topic":"...","diff":"easy","explain":""}]\n\n' +
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
    const liveModels = await getLiveGeminiModels(key);
    const fallbackList = [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash'
    ];
    const models = liveModels.length > 0 ? liveModels : fallbackList;

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      try {
        const genConfig = {
          maxOutputTokens: 8192,
          temperature: isCBT ? 0.15 : 0.85
        };
        if (isCBT) genConfig.responseMimeType = 'application/json';

        const r = await fetchGemini(model, key, {
          systemInstruction: { parts: [{ text: system }] },
          contents: contents,
          generationConfig: genConfig
        }, 30000);

        const data = await r.json().catch(function () { return {}; });

        if (r.ok) {
          const parts = data.candidates && data.candidates[0] &&
            data.candidates[0].content && data.candidates[0].content.parts;
          let text = parts ? parts.map(function (p) { return p.text || ''; }).join('').trim() : '';
          if (text) {
            if (isCBT) {
              text = cleanCBTJson(text);
              if (!isJsonComplete(text)) {
                console.warn('[Gemini] ' + model + ' returned truncated JSON');
                errors.push(model + ':Truncated');
                continue;
              }
              // 🔥 Apply the backend shuffle magic here!
              text = shuffleAnswers(text);
            }
            return reply(text);
          }
          errors.push(model + ':Empty');
          continue;
        }

        const msg = (data.error && data.error.message) || ('HTTP ' + r.status);
        errors.push(model + ':' + r.status);

        if (r.status === 401 || r.status === 403 || (r.status === 400 && /API_KEY_INVALID/i.test(msg))) {
          authError = msg.slice(0, 50);
          break;
        }
        if (r.status === 429) { sawQuota = true; continue; }

      } catch (e) {
        errors.push(model + ':' + (e.name === 'AbortError' ? 'Timeout' : 'NetErr'));
      }
    }
  }

  if (groqKey) {
    const gRes = await fetchGroqFallback(groqKey, system, message, isCBT, hasImages, allImages);
    if (gRes.ok && gRes.text) {
      let gText = gRes.text;
      if (isCBT) {
        gText = cleanCBTJson(gText);
        gText = shuffleAnswers(gText); // Shuffle for Groq too!
      }
      return reply(gText);
    }
    errors.push(gRes.err);
  }

  const errSummary = errors.slice(0, 3).join(' | ');
  console.error('[ai-coach] failed:', errSummary);
  if (authError) return http.json(res, 401, { error: 'AUTH_ERROR', message: 'Invalid Key: ' + authError });
  if (sawQuota) return http.json(res, 429, { error: 'QUOTA_EXCEEDED', message: 'Quota hit. Retry in 1 min.' });
  return http.json(res, 502, { error: 'AI_UNAVAILABLE', message: errSummary });
};

module.exports.config = { maxDuration: 60 };
