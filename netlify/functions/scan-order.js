// netlify/functions/scan-order.js
//
// Reads a delivery screenshot and returns either:
//   - order offer:   { pay, miles, minutes }
//   - earnings summary: { gross, hours }
// The Anthropic API key lives ONLY here as an environment variable —
// it is never sent to the browser.
//
// Cost guards:
//   - POST only
//   - rejects images larger than ~600KB (browser already shrinks to ~150KB)
//   - caps model response at 150 tokens, uses the small/cheap Haiku model
//   - 12-second hard timeout
//   - global daily scan cap (worst-case spend ceiling)

const MAX_IMAGE_BYTES = 600 * 1024; // ~600KB ceiling on the base64 payload

// Global daily scan cap — a hard ceiling on total scans per day across ALL
// users, so worst-case API spend is bounded no matter who calls or how often.
// This lives in function memory: it resets whenever the function cold-starts
// (which on free tier happens fairly often), so it's a softer cap than a
// database-backed counter — but it still stops a sustained flood within a
// warm instance, with zero extra infrastructure. Tune to your comfort level.
const MAX_SCANS_PER_DAY = 500;
let scanCount = 0;
let scanCountDay = "";

function dayStamp() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

exports.handler = async (event) => {
  // CORS / preflight
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // Global daily cap. Reset the counter when the day rolls over.
  const today = dayStamp();
  if (today !== scanCountDay) {
    scanCountDay = today;
    scanCount = 0;
  }
  if (scanCount >= MAX_SCANS_PER_DAY) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        error: "The scanner has hit its daily limit. Please enter your numbers manually — it'll reset tomorrow.",
      }),
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ error: "The scanner isn't set up correctly. Please use manual entry for now." }),
    };
  }

  // Parse the incoming image
  let image, mediaType, kind;
  try {
    const parsed = JSON.parse(event.body || "{}");
    image = parsed.image;          // base64 string, no data: prefix
    mediaType = parsed.mediaType || "image/jpeg";
    kind = parsed.kind === "summary" ? "summary" : "offer";
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid request body." }),
    };
  }

  if (!image || typeof image !== "string") {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "No image provided." }),
    };
  }

  if (image.length > MAX_IMAGE_BYTES) {
    return {
      statusCode: 413,
      headers,
      body: JSON.stringify({ error: "Image too large — please try again." }),
    };
  }

  // Call Anthropic with a tight timeout so a hung request can never
  // run long enough to matter on the meter.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000); // 12s hard stop

  // Two prompt modes: a single order offer, or an end-of-day earnings summary.
  const promptText = kind === "summary"
    ? "This is a screenshot from a food delivery app (DoorDash, Uber Eats, Grubhub) showing a driver's earnings. " +
      "Extract TWO numbers as JSON: total earnings, and total time worked in hours.\n\n" +
      "EARNINGS — read the most prominent earnings total on the screen. This is usually a large dollar amount near the top or center, often labeled 'Dash summary', 'Dash total', 'Total earnings', 'Today', or a date. TAKE THIS NUMBER. " +
      "For example, if the screen says 'Dash summary $104.35', the earnings are 104.35.\n" +
      "Only AVOID these specific cases: a single individual order's pay (labeled 'This offer' or 'This order'), or an 'Available balance' / cash-out amount. " +
      "If you see both a session total (like 'Dash summary') and a separate 'this week' figure, use the session total — the larger prominent number being celebrated, not the weekly line item.\n\n" +
      "HOURS — find total time worked, often labeled 'Total online time', 'Active time', or 'Dash time'. Convert 'X hr Y min' to decimal hours (e.g. '4 hr 18 min' = 4.3). " +
      "Ignore offer/delivery counts like '9 out of 20'.\n\n" +
      "Return ONLY raw JSON, no markdown: {\"gross\": number, \"hours\": number}. " +
      "Use 0 only if a value is genuinely not present on the screen."
    : "This is a screenshot of a food delivery order offer (DoorDash, Uber Eats, or Grubhub). " +
      "Extract the payout in dollars, the delivery distance in miles, and the estimated " +
      "delivery time in minutes. Return ONLY raw JSON, no markdown or explanation: " +
      '{"pay": number, "miles": number, "minutes": number}. ' +
      "Use 0 for any value you cannot find.";

  try {
    scanCount++; // count this billable call against the daily cap
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", // small + cheap
        max_tokens: 150,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: image },
              },
              { type: "text", text: promptText },
            ],
          },
        ],
      }),
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      // Branch on status so the driver sees the true cause, not a generic error.
      const s = resp.status;
      let message;
      let retry = false;     // should the UI offer/encourage a manual retry?
      let transient = false; // is this a brief outage worth ONE silent auto-retry?

      if (s === 401 || s === 403) {
        // Auth problem — server config issue, NOT an outage. Never auto-retry.
        message = "The scanner isn't set up correctly. Please use manual entry for now.";
      } else if (s === 429) {
        // Rate limited — auto-retrying makes it worse. Manual retry after a wait only.
        message = "Too many scans right now. Wait a minute and try again.";
        retry = true;
      } else if (s === 529 || s === 500 || s === 502 || s === 503) {
        // Anthropic-side outage/overload — short-lived. Safe to auto-retry once.
        message = "The scan service is briefly unavailable. Try again in a moment, or use manual entry.";
        retry = true;
        transient = true;
      } else {
        message = "Couldn't scan that order. Try again, or use manual entry.";
        retry = true;
      }

      return {
        statusCode: 200, // return 200 so the browser reads our clean message, not a raw fetch error
        headers,
        body: JSON.stringify({ error: message, retry, transient, upstreamStatus: s }),
      };
    }

    const data = await resp.json();
    const text = (Array.isArray(data.content) ? data.content : [])
      .map((b) => b.text || "")
      .join("");

    if (!text) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ error: "The scan service is briefly unavailable. Try again in a moment, or use manual entry.", retry: true, transient: true }),
      };
    }

    // Pull the JSON object out of whatever came back
    const match = text.match(/\{[^{}]+\}/);
    let parsed;
    try {
      parsed = JSON.parse(match ? match[0] : text);
    } catch {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ error: "Could not read the numbers from that image. Try a clearer screenshot, or use manual entry." }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(
        kind === "summary"
          ? {
              gross: Number(parsed.gross) || 0,
              hours: Number(parsed.hours) || 0,
            }
          : {
              pay: Number(parsed.pay) || 0,
              miles: Number(parsed.miles) || 0,
              minutes: Number(parsed.minutes) || 0,
            }
      ),
    };
  } catch (err) {
    clearTimeout(timeout);
    const aborted = err?.name === "AbortError";
    return {
      statusCode: 200, // clean message for the browser, not a raw 5xx
      headers,
      body: JSON.stringify({
        error: aborted
          ? "The scan service is taking too long. Try again in a moment, or use manual entry."
          : "Couldn't reach the scan service. Check your connection and try again.",
        retry: true,
        transient: aborted, // a timeout is worth one silent retry; a network failure isn't
      }),
    };
  }
};
    };
  }
};
