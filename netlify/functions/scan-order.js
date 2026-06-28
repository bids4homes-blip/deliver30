const MAX_IMAGE_BYTES = 600 * 1024;
const MAX_SCANS_PER_DAY = 500;
var scanCount = 0;
var scanCountDay = "";

function dayStamp() {
return new Date().toISOString().slice(0, 10);
}

exports.handler = async function(event) {
var headers = {
"Access-Control-Allow-Origin": "*",
"Access-Control-Allow-Headers": "Content-Type",
"Access-Control-Allow-Methods": "POST, OPTIONS",
"Content-Type": "application/json"
};

if (event.httpMethod === "OPTIONS") {
return { statusCode: 204, headers: headers, body: "" };
}

if (event.httpMethod !== "POST") {
return { statusCode: 405, headers: headers, body: JSON.stringify({ error: "Method not allowed" }) };
}

var today = dayStamp();
if (today !== scanCountDay) {
scanCountDay = today;
scanCount = 0;
}
if (scanCount >= MAX_SCANS_PER_DAY) {
return {
statusCode: 200,
headers: headers,
body: JSON.stringify({ error: "The scanner has hit its daily limit. Please enter your numbers manually." })
};
}

var apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
return {
statusCode: 200,
headers: headers,
body: JSON.stringify({ error: "The scanner isn't set up correctly. Please use manual entry for now." })
};
}

var image, mediaType, kind;
try {
var parsed = JSON.parse(event.body || "{}");
image = parsed.image;
mediaType = parsed.mediaType || "image/jpeg";
kind = parsed.kind === "summary" ? "summary" : "offer";
} catch (e) {
return { statusCode: 400, headers: headers, body: JSON.stringify({ error: "Invalid request body." }) };
}

if (!image || typeof image !== "string") {
return { statusCode: 400, headers: headers, body: JSON.stringify({ error: "No image provided." }) };
}

if (image.length > MAX_IMAGE_BYTES) {
return { statusCode: 413, headers: headers, body: JSON.stringify({ error: "Image too large." }) };
}

var promptText;
if (kind === "summary") {
promptText = "This is a screenshot from a food delivery app (DoorDash, Uber Eats, Grubhub) showing a driver's earnings. " +
"Extract TWO numbers as JSON: total earnings, and total time worked in hours.\n\n" +
"EARNINGS — read the most prominent earnings total on the screen. This is usually a large dollar amount near the top or center, often labeled 'Dash summary', 'Dash total', 'Total earnings', 'Today', or a date. TAKE THIS NUMBER. " +
"For example, if the screen says 'Dash summary $104.35', the earnings are 104.35.\n" +
"Only AVOID these specific cases: a single individual order's pay (labeled 'This offer' or 'This order'), or an 'Available balance' / cash-out amount. " +
"If you see both a session total (like 'Dash summary') and a separate 'this week' figure, use the session total — the larger prominent number being celebrated, not the weekly line item.\n\n" +
"HOURS — find total time worked, often labeled 'Total online time', 'Active time', or 'Dash time'. Convert 'X hr Y min' to decimal hours (e.g. '4 hr 18 min' = 4.3). " +
"Ignore offer/delivery counts like '9 out of 20'.\n\n" +
"Return ONLY raw JSON, no markdown: {\"gross\": number, \"hours\": number}. " +
"Use 0 only if a value is genuinely not present on the screen.";
} else {
promptText = "This is a screenshot of a food delivery order offer (DoorDash, Uber Eats, or Grubhub). " +
"Extract the payout in dollars, the delivery distance in miles, and the estimated " +
"delivery time in minutes. Return ONLY raw JSON, no markdown or explanation: " +
"{\"pay\": number, \"miles\": number, \"minutes\": number}. " +
"Use 0 for any value you cannot find.";
}

var controller = new AbortController();
var timeout = setTimeout(function() { controller.abort(); }, 12000);

try {
scanCount++;
var resp = await fetch("https://api.anthropic.com/v1/messages", {
method: "POST",
signal: controller.signal,
headers: {
"Content-Type": "application/json",
"x-api-key": apiKey,
"anthropic-version": "2023-06-01"
},
body: JSON.stringify({
model: "claude-haiku-4-5-20251001",
max_tokens: 150,
messages: [
{
role: "user",
content: [
{
type: "image",
source: { type: "base64", media_type: mediaType, data: image }
},
{ type: "text", text: promptText }
]
}
]
})
});

clearTimeout(timeout);

if (!resp.ok) {
var s = resp.status;
var message, retry = false, transient = false;

if (s === 401 || s === 403) {
message = "The scanner isn't set up correctly. Please use manual entry for now.";
} else if (s === 429) {
message = "Too many scans right now. Wait a minute and try again.";
retry = true;
} else if (s === 529 || s === 500 || s === 502 || s === 503) {
message = "The scan service is briefly unavailable. Try again in a moment, or use manual entry.";
retry = true;
transient = true;
} else {
message = "Couldn't scan that order. Try again, or use manual entry.";
retry = true;
}

return {
statusCode: 200,
headers: headers,
body: JSON.stringify({ error: message, retry: retry, transient: transient, upstreamStatus: s })
};
}

var data = await resp.json();
var text = "";
if (Array.isArray(data.content)) {
for (var i = 0; i < data.content.length; i++) {
if (data.content[i].text) text += data.content[i].text;
}
}

if (!text) {
return {
statusCode: 200,
headers: headers,
body: JSON.stringify({ error: "The scan service is briefly unavailable. Try again in a moment.", retry: true, transient: true })
};
}

var match = text.match(/\{[^{}]+\}/);
var result;
try {
result = JSON.parse(match ? match[0] : text);
} catch (e) {
return {
statusCode: 200,
headers: headers,
body: JSON.stringify({ error: "Could not read the numbers from that image. Try a clearer screenshot, or use manual entry." })
};
}

if (kind === "summary") {
return {
statusCode: 200,
headers: headers,
body: JSON.stringify({
gross: Number(result.gross) || 0,
hours: Number(result.hours) || 0
})
};
} else {
return {
statusCode: 200,
headers: headers,
body: JSON.stringify({
pay: Number(result.pay) || 0,
miles: Number(result.miles) || 0,
minutes: Number(result.minutes) || 0
})
};
}
} catch (err) {
clearTimeout(timeout);
var aborted = err && err.name === "AbortError";
return {
statusCode: 200,
headers: headers,
body: JSON.stringify({
error: aborted
? "The scan service is taking too long. Try again in a moment, or use manual entry."
: "Couldn't reach the scan service. Check your connection and try again.",
retry: true,
transient: aborted
})
};
}
};
