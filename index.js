import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// ✅ Twilio client
const client = new twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ✅ MongoDB connection
const mongo = new MongoClient(process.env.MONGO_URI);
let leadsCollection;
let messagesCollection;

function getPublicBaseUrl() {
  const explicit = process.env.PUBLIC_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const railwayStatic = process.env.RAILWAY_STATIC_URL;
  if (railwayStatic) return railwayStatic.replace(/\/+$/, "");

  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railwayDomain) return `https://${railwayDomain}`.replace(/\/+$/, "");

  return null;
}

/** DB/API may store handover as boolean or string ("true") — both mean bot silent. */
function isHandoverOn(lead) {
  const h = lead?.handover;
  return h === true || h === "true" || h === 1;
}

/** $push requires arrays; POST /leads / bad docs may have null → normalize before $push. */
function patchNullQueryArrays(lead) {
  if (!lead) return { productQueries: [], schemesQueries: [], ratesQueries: [] };
  const patch = {};
  if (!Array.isArray(lead.productQueries)) patch.productQueries = [];
  if (!Array.isArray(lead.schemesQueries)) patch.schemesQueries = [];
  if (!Array.isArray(lead.ratesQueries)) patch.ratesQueries = [];
  return patch;
}

// ✅ Send Main Menu
async function sendMainMenu(to) {
  const fromNum = process.env.TWILIO_WHATSAPP_NUMBER;
  try {
    await client.messages.create({
      from: fromNum,
      to,
      body: `✨ Welcome to Trichy Gold Jewellers! ✨

Please select your desired option:
1️⃣ Query about Product
2️⃣ Explore Schemes  
3️⃣ Gold Rates
4️⃣ End Chat

Type the number (1-4) to select.`
    });
    console.log("✅ Main menu sent successfully");
  } catch (e) {
    console.error("❌ Twilio could not send main menu:", e.message);
    if (e.code) console.error("   Twilio code:", e.code);
    if (e.moreInfo) console.error("   ", e.moreInfo);
    console.error(
      '   Check TWILIO_WHATSAPP_NUMBER matches your sandbox sender, e.g. whatsapp:+14155238886'
    );
  }
}

// ✅ Send Items Menu
async function sendItemsMenu(to) {
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body: `Select the jewellery item you are interested in:

1️⃣ Bangle
2️⃣ Chain
3️⃣ Necklace
4️⃣ Earring
5️⃣ Ring
6️⃣ Pendant Set
7️⃣ Stud
8️⃣ Mangal Sutra
9️⃣ Band Ring

Type the number (1-9) or the item name to select.`
  });
  console.log("✅ Items menu sent successfully");
}

// ✅ Prompt for Name
async function promptForName(to) {
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body: "Please enter your name:"
  });
}

// ✅ Prompt for Details
async function promptForDetails(to) {
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body: "You can post multiple media/voice/text to further qualify your query. Type 'End' when finished."
  });
}


// ✅ Save Item Selection and Set State to Name - FIXED!
async function saveItemSelection(to, item) {
  // Get fresh lead data to check if name exists
  const lead = await leadsCollection.findOne({ mobile: to });
  
  await leadsCollection.updateOne(
    { mobile: to },
    { $set: { currentProduct: item, state: "name" } },
    { upsert: true }
  );
   
    
  // Send confirmation message
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body: `✅ Great! You are interested in ${item}.`
  });
  
  // Check if customer already has a name
  if (lead && lead.name) {
    // Skip name collection, go directly to details
    const queryArray = Array.isArray(lead.productQueries) ? lead.productQueries : [];
    const nextId = queryArray.length + 1;
    
    const newQuery = {
      id: nextId,
      createdAt: new Date(),
      details: []
    };
    
    await leadsCollection.updateOne(
      { mobile: to },
      { 
        $set: { 
          state: "details",
          currentQueryId: nextId,
          ...patchNullQueryArrays(lead)
        },
        $push: { productQueries: newQuery }
      }
    );
    await promptForDetails(to);
  } else {
    // First time, ask for name
    await promptForName(to);
  }
}

// ✅ Store Detail Message
async function storeDetail(to, msg, queryType, queryId) {
  const detail = { timestamp: new Date() };
  
  if (msg.Body) {
    detail.type = "text";
    detail.content = msg.Body;
  } else if (msg.NumMedia > 0) {
    const mediaType = msg.MediaContentType0;
    detail.content = msg.MediaUrl0;
    if (mediaType.startsWith("image/")) {
      detail.type = "image";
    } else if (mediaType.startsWith("audio/")) {
      detail.type = "voice";
    } else {
      detail.type = "media";
    }
  }

  if (detail.type) {
    const updatePath = `${queryType}.$.details`;
    await leadsCollection.updateOne(
      { 
        mobile: to,
        [`${queryType}.id`]: queryId
      },
      { $push: { [updatePath]: detail } }
    );
    
    // No prompt after storing detail - allow successive posts until user types "end"
  }
}

// ✅ Handle Incoming Message - NEW ARRAY-BASED STRUCTURE
async function handleIncomingMessage(msg) {
  const from = msg.From;
  const body = msg.Body ? msg.Body.toLowerCase() : "";
  const numMedia = parseInt(msg.NumMedia || 0);

  let lead = await leadsCollection.findOne({ mobile: from });

  if (!lead) {
    lead = {
      name: null,
      mobile: from,
      handover: false,
      state: "main",
      currentQueryType: null,
      currentQueryId: null,
      currentProduct: null,
      productQueries: [],
      schemesQueries: [],
      ratesQueries: [],
      createdAt: new Date()
    };
    await leadsCollection.insertOne(lead);
  }

  // Bad data: handover shouldn't pair with state "main" (real handover sets state null).
  if (isHandoverOn(lead) && lead.state === "main") {
    console.log(
      "⚠️ Clearing inconsistent handover+main (e.g. from POST /leads) — resuming bot."
    );
    await leadsCollection.updateOne(
      { mobile: from },
      { $set: { handover: false } }
    );
    lead = { ...lead, handover: false };
  }

  console.log("📋 Lead:", {
    from,
    handover: lead.handover,
    handoverOn: isHandoverOn(lead),
    state: lead.state
  });

  // Recovery: handover or stuck flow — type "menu" or "reset" for welcome again
  if (body === "menu" || body === "reset") {
    await leadsCollection.updateOne(
      { mobile: from },
      {
        $set: {
          handover: false,
          state: "main",
          currentQueryType: null,
          currentQueryId: null,
          currentProduct: null
        }
      }
    );
    await sendMainMenu(from);
    return;
  }

  if (isHandoverOn(lead)) {
    console.log(
      "🔇 Handover mode (End Chat) — bot only stores messages. Reply with: menu or reset."
    );
    // Bot silent, store in messages collection
    const newMessage = { timestamp: new Date(), from: "customer" };
    
    if (body) {
      newMessage.type = "text";
      newMessage.content = msg.Body;
    } else if (numMedia > 0) {
      newMessage.type = msg.MediaContentType0.startsWith("image/") ? "image" : msg.MediaContentType0.startsWith("audio/") ? "voice" : "media";
      newMessage.content = msg.MediaUrl0;
    }

    if (newMessage.type) {
      await messagesCollection.updateOne(
        { mobile: from },
        { $push: { messages: newMessage } },
        { upsert: true }
      );
    }
    return; // No response
  }

  // Handle based on state
  if (lead.state === "name") {
    // Get the next query ID for the current query type
    const rawArr = lead[lead.currentQueryType];
    const queryArray = Array.isArray(rawArr) ? rawArr : [];
    const nextId = queryArray.length + 1;
    
    // Create new query entry
    const newQuery = {
      id: nextId,
      createdAt: new Date(),
      details: []
    };
    
    // Add product info if it's a product query
    if (lead.currentQueryType === "productQueries" && lead.currentProduct) {
      newQuery.productInterested = lead.currentProduct;
    }
    
    await leadsCollection.updateOne(
      { mobile: from },
      { 
        $set: { 
          name: msg.Body, 
          state: "details",
          currentQueryId: nextId,
          ...patchNullQueryArrays(lead)
        },
        $push: { [lead.currentQueryType]: newQuery }
      }
    );
    
    await promptForDetails(from);
    return;
  }

  if (lead.state === "details") {
    // Check if user wants to end (only as separate text message, case-insensitive: END/End/end all work)
    if (body === "end") {
      // Clear current query tracking and return to main menu
      await leadsCollection.updateOne(
        { mobile: from },
        { 
          $set: { 
            state: "main",
            currentQueryType: null,
            currentQueryId: null,
            currentProduct: null
          }
        }
      );
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: "Thank you for the details! You can explore more options or end the chat anytime."
      });
      await sendMainMenu(from);
    } else if (msg.Body || msg.NumMedia > 0) {
      // Store the detail (text or media)
      await storeDetail(from, msg, lead.currentQueryType, lead.currentQueryId);
    } else {
      // No content, ask what they want to do
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: "Please send a message, media, or type 'end' to finish."
      });
    }
    return;
  }

  // Handle items menu state
  if (lead.state === "items") {
    const itemsMap = {
      "1": "bangle",
      "bangle": "bangle",
      "2": "chain", 
      "chain": "chain",
      "3": "necklace",
      "necklace": "necklace",
      "4": "earring",
      "earring": "earring",
      "5": "ring",
      "ring": "ring",
      "6": "pendant set",
      "pendant": "pendant set",
      "7": "stud",
      "stud": "stud",
      "8": "mangal sutra",
      "mangalsutra": "mangal sutra",
      "9": "band ring",
      "band": "band ring"
    };

    const item = itemsMap[body];
    if (item) {
      await saveItemSelection(from, item);
    } else {
      await sendItemsMenu(from);
    }
    return;
  }

  // Handle main menu selections ONLY if in main state
  if (lead.state === "main") {
    let choiceRaw;
    if (msg.Interactive && msg.Interactive.ListReply) {
      choiceRaw = msg.Interactive.ListReply.Id;
    } else if (msg.ButtonText) {
      choiceRaw = msg.ButtonText;
    } else {
      choiceRaw = body;
    }
    // Must be a string — ListReply.Id / numbers have no .includes(); undefined throws.
    const choice = String(choiceRaw ?? "").trim().toLowerCase();

    // Map numbers to choices
    if (choice === "1" || choice === "product" || choice.includes("query about product")) {
      await leadsCollection.updateOne(
        { mobile: from },
        { $set: { currentQueryType: "productQueries", state: "items" } }
      );
      await sendItemsMenu(from);
    } else if (choice === "2" || choice === "schemes" || choice.includes("explore schemes")) {
      await leadsCollection.updateOne(
        { mobile: from },
        { $set: { currentQueryType: "schemesQueries" } }
      );
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: "We have exciting saving schemes! Our team will contact you with details."
      });
      
      // Check if customer already has a name
      if (lead.name) {
        // Skip name collection, go directly to details
        const queryArray = Array.isArray(lead.schemesQueries)
          ? lead.schemesQueries
          : [];
        const nextId = queryArray.length + 1;
        
        const newQuery = {
          id: nextId,
          createdAt: new Date(),
          details: []
        };
        
        await leadsCollection.updateOne(
          { mobile: from },
          { 
            $set: { 
              state: "details",
              currentQueryId: nextId,
              ...patchNullQueryArrays(lead)
            },
            $push: { schemesQueries: newQuery }
          }
        );
        await promptForDetails(from);
  } else {
        // First time, ask for name
        await leadsCollection.updateOne(
          { mobile: from },
          { $set: { state: "name" } }
        );
        await promptForName(from);
      }
    } else if (choice === "3" || choice === "rates" || choice.includes("gold rates")) {
      await leadsCollection.updateOne(
        { mobile: from },
        { $set: { currentQueryType: "ratesQueries" } }
      );
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: "Today's 22k Gold Rate: ₹5,200/gm."
      });
      
      // Check if customer already has a name
      if (lead.name) {
        // Skip name collection, go directly to details
        const queryArray = Array.isArray(lead.ratesQueries)
          ? lead.ratesQueries
          : [];
        const nextId = queryArray.length + 1;
        
        const newQuery = {
          id: nextId,
          createdAt: new Date(),
          details: []
        };
        
        await leadsCollection.updateOne(
          { mobile: from },
          { 
            $set: { 
              state: "details",
              currentQueryId: nextId,
              ...patchNullQueryArrays(lead)
            },
            $push: { ratesQueries: newQuery }
          }
        );
        await promptForDetails(from);
      } else {
        // First time, ask for name
        await leadsCollection.updateOne(
          { mobile: from },
          { $set: { state: "name" } }
        );
        await promptForName(from);
      }
    } else if (choice === "4" || choice === "end" || choice.includes("end")) {
      // ONLY Option 4 triggers handover
      await leadsCollection.updateOne(
        { mobile: from },
        { $set: { handover: true, state: null } }
      );
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: "Thank you for contacting Trichy Gold Jewellers! 💎"
      });
    } else {
      // Invalid main menu choice, show main menu again
      await sendMainMenu(from);
    }
  } else {
    // If in unknown state, reset to main menu
    await leadsCollection.updateOne(
      { mobile: from },
      { $set: { state: "main" } }
    );
    await sendMainMenu(from);
  }
}

// Home — app has no default page; WhatsApp hits POST /whatsapp-webhook
app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>hello-ngrok</title></head>
<body style="font-family:system-ui;max-width:36rem;margin:2rem;line-height:1.5">
  <h1>hello-ngrok</h1>
  <p>Server is running. There is no UI at <code>/</code> by default.</p>
  <ul>
    <li><a href="/panel">Sales panel</a> <code>/panel</code></li>
    <li><a href="/whatsapp-webhook">Webhook test (GET)</a> <code>/whatsapp-webhook</code></li>
  </ul>
</body></html>`);
});

// ✅ Webhook endpoint
app.post("/whatsapp-webhook", async (req, res) => {
  console.log("🔥 WEBHOOK CALLED - Someone sent a message!");

  const msg = req.body;
  console.log("Full request body:", JSON.stringify(req.body, null, 2));

  try {
    await handleIncomingMessage(msg);
  } catch (e) {
    console.error("❌ handleIncomingMessage error:", e);
  }

  res.sendStatus(200);
});


app.post("/leads", async (req, res) => {
  try {
    const rawH = req.body.handover;
    const handoverBool =
      rawH === true || rawH === "true" || rawH === 1 || rawH === "1";

    const leadData = {
      name: req.body.name,
      mobile: req.body.mobile,
      handover: handoverBool,
      state: req.body.state,
      currentQueryType: req.body.currentQueryType,
      currentQueryId: req.body.currentQueryId,
      currentProduct: req.body.currentProduct,
      productQueries: Array.isArray(req.body.productQueries)
        ? req.body.productQueries
        : [],
      schemesQueries: Array.isArray(req.body.schemesQueries)
        ? req.body.schemesQueries
        : [],
      ratesQueries: Array.isArray(req.body.ratesQueries)
        ? req.body.ratesQueries
        : [],
      createdAt: new Date()
      // Extra fields for reference:
      // message_content: req.body.message_content,
      // message_sid: req.body.message_sid
    };

    const result = await leadsCollection.insertOne(leadData);
    res.json({ success: true, id: result.insertedId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// === Authentic WhatsApp Web Interface ===

// WhatsApp Web CSS - Light Theme
const whatsappWebCSS = `
<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
  background: #f0f2f5;
  color: #3b4a54;
  height: 100vh;
  overflow: hidden;
}

.app-container {
  display: flex;
  height: 100vh;
  background: #f0f2f5;
}

/* Left Sidebar - Chat List */
.sidebar {
  width: 30%;
  min-width: 300px;
  background: #ffffff;
  border-right: 1px solid #e9edef;
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  background: #f0f2f5;
  padding: 10px 16px;
  border-bottom: 1px solid #e9edef;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sidebar-title {
  color: #3b4a54;
  font-size: 16px;
  font-weight: 500;
}

.sidebar-subtitle {
  color: #667781;
  font-size: 12px;
  margin-top: 2px;
}

.chat-list {
  flex: 1;
  overflow-y: auto;
  background: #ffffff;
}

.chat-item {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #f0f2f5;
  cursor: pointer;
  transition: background-color 0.15s ease;
  text-decoration: none;
  color: inherit;
}

.chat-item:hover {
  background-color: #f5f6fa;
}

.chat-item.active {
  background-color: #e7f3ff;
}

.avatar {
  width: 49px;
  height: 49px;
  border-radius: 50%;
  background: #dfe5e7;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #667781;
  font-weight: 500;
  font-size: 18px;
  margin-right: 13px;
  flex-shrink: 0;
}

.chat-info {
  flex: 1;
  min-width: 0;
}

.chat-name {
  font-size: 17px;
  font-weight: 400;
  color: #111b21;
  margin-bottom: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-preview {
  font-size: 14px;
  color: #667781;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 2px;
}

.chat-time {
  font-size: 12px;
  color: #667781;
  margin-left: auto;
  flex-shrink: 0;
}

.chat-stats {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}

.stat-badge {
  background: #00a884;
  color: #ffffff;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 10px;
  font-weight: 500;
}

/* Main Chat Area */
.main-chat {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #e5ddd5;
}

.chat-header {
  background: #f0f2f5;
  padding: 10px 16px;
  border-bottom: 1px solid #e9edef;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.chat-header-left {
  display: flex;
  align-items: center;
}

.back-btn {
  background: none;
  border: none;
  color: #667781;
  font-size: 20px;
  margin-right: 16px;
  cursor: pointer;
  padding: 8px;
  border-radius: 50%;
  transition: background-color 0.15s ease;
}

.back-btn:hover {
  background-color: #e9edef;
}

.chat-header-info h2 {
  font-size: 16px;
  font-weight: 500;
  color: #111b21;
  margin-bottom: 2px;
}

.chat-header-info p {
  font-size: 13px;
  color: #667781;
}

.chat-messages {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
  background: #e5ddd5;
  background-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><defs><pattern id="grain" width="100" height="100" patternUnits="userSpaceOnUse"><circle cx="25" cy="25" r="1" fill="%23000000" opacity="0.02"/><circle cx="75" cy="75" r="1" fill="%23000000" opacity="0.02"/><circle cx="50" cy="10" r="0.5" fill="%23000000" opacity="0.02"/><circle cx="10" cy="60" r="0.5" fill="%23000000" opacity="0.02"/><circle cx="90" cy="40" r="0.5" fill="%23000000" opacity="0.02"/></pattern></defs><rect width="100" height="100" fill="url(%23grain)"/></svg>');
}

.message-group {
  margin-bottom: 20px;
}

.message-group-title {
  font-size: 12px;
  color: #667781;
  text-align: center;
  margin-bottom: 15px;
  position: relative;
}

.message-group-title::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 1px;
  background: #d1d7db;
  z-index: 1;
}

.message-group-title span {
  background: #e5ddd5;
  padding: 0 12px;
  position: relative;
  z-index: 2;
}

.message-bubble {
  max-width: 65%;
  margin-bottom: 1px;
  position: relative;
}

.message-bubble.customer {
  margin-left: 0;
}

.message-bubble.salesperson {
  margin-left: auto;
}

.message-content {
  background: #ffffff;
  padding: 6px 7px 8px 9px;
  border-radius: 7.5px;
  position: relative;
  word-wrap: break-word;
  box-shadow: 0 1px 0.5px rgba(11, 20, 26, 0.13);
}

.message-bubble.customer .message-content {
  background: #ffffff;
  border-radius: 7.5px 7.5px 7.5px 0;
}

.message-bubble.salesperson .message-content {
  background: #d1f7c4;
  border-radius: 7.5px 7.5px 0 7.5px;
}

.message-text {
  font-size: 14.2px;
  line-height: 19px;
  color: #111b21;
}

.message-time {
  font-size: 11px;
  color: #667781;
  margin-top: 4px;
  text-align: right;
}

.message-bubble.customer .message-time {
  color: #4a4a4a;
}

.message-bubble.salesperson .message-time {
  color: #667781;
}

.message-image {
  max-width: 200px;
  border-radius: 7.5px;
  margin-bottom: 4px;
}

.message-audio {
  width: 200px;
}

/* Reply Input */
.reply-container {
  background: #f0f2f5;
  padding: 8px 16px;
  border-top: 1px solid #e9edef;
}

.reply-form {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.message-input {
  flex: 1;
  background: #ffffff;
  border: none;
  border-radius: 21px;
  padding: 6px 10px;
  color: #111b21;
  font-size: 14px;
  outline: none;
  resize: none;
  min-height: 16px;
  max-height: 80px;
  font-family: inherit;
  box-shadow: 0 1px 3px rgba(11, 20, 26, 0.08);
  max-width: 60%;
}

.message-input::placeholder {
  color: #667781;
}

.send-button {
  background: #00a884;
  border: none;
  border-radius: 50%;
  width: 45px;
  height: 45px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.send-button:hover {
  background: #06cf9c;
}

.send-button svg {
  width: 20px;
  height: 20px;
  fill: #ffffff;
}

/* Empty State */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #667781;
  text-align: center;
}

.empty-state-icon {
  font-size: 64px;
  margin-bottom: 20px;
  opacity: 0.5;
}

.empty-state h3 {
  font-size: 20px;
  font-weight: 300;
  margin-bottom: 8px;
  color: #3b4a54;
}

.empty-state p {
  font-size: 14px;
  opacity: 0.8;
}

/* Scrollbar Styling */
::-webkit-scrollbar {
  width: 6px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: #c4c4c4;
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: #a8a8a8;
}

/* Responsive */
@media (max-width: 768px) {
  .app-container {
    flex-direction: column;
  }
  
  .sidebar {
    width: 100%;
    height: 40%;
    min-width: auto;
  }
  
  .main-chat {
    height: 60%;
  }
}
</style>
`;

// List leads with handover true - WhatsApp Web Style
app.get("/panel", async (req, res) => {
  const leads = await leadsCollection
    .find({ $or: [{ handover: true }, { handover: "true" }] })
    .toArray();
  
  // Set ultra-strict security headers to prevent all external requests and popups
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: media.twilio.com https://*.twilio.com; media-src 'self' data: https: media.twilio.com https://*.twilio.com; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'self'; connect-src 'self'; font-src 'self'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  let html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: media.twilio.com https://*.twilio.com; media-src 'self' data: https: media.twilio.com https://*.twilio.com; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'self'; connect-src 'self'; font-src 'self'">
      <title>WhatsApp Web - Trichy Gold</title>
      ${whatsappWebCSS}
    </head>
    <body>
      <div class="app-container">
        <div class="sidebar">
          <div class="sidebar-header">
            <div>
              <div class="sidebar-title">Trichy Gold Jewellers</div>
              <div class="sidebar-subtitle">Sales Panel</div>
            </div>
          </div>
          
          <div class="chat-list">
  `;
  
  if (leads.length === 0) {
    html += `
      <div class="empty-state">
        <div class="empty-state-icon">💬</div>
        <h3>No conversations</h3>
        <p>No customers have been handed over yet.</p>
      </div>
    `;
  } else {
    leads.forEach(lead => {
      const totalQueries = (lead.productQueries?.length || 0) + (lead.schemesQueries?.length || 0) + (lead.ratesQueries?.length || 0);
      const lastActivity = lead.createdAt ? new Date(lead.createdAt).toLocaleDateString() : 'Today';
      const initials = lead.name ? lead.name.charAt(0).toUpperCase() : '?';
      const preview = totalQueries > 0 ? `${totalQueries} queries completed` : 'New conversation';
      
      html += `
        <a href="/chat/${lead.mobile}" class="chat-item">
          <div class="avatar">${initials}</div>
          <div class="chat-info">
            <div class="chat-name">${lead.name || 'Unknown Customer'}</div>
            <div class="chat-preview">${preview}</div>
            <div class="chat-stats">
              <span class="stat-badge">P: ${lead.productQueries?.length || 0}</span>
              <span class="stat-badge">S: ${lead.schemesQueries?.length || 0}</span>
              <span class="stat-badge">R: ${lead.ratesQueries?.length || 0}</span>
            </div>
          </div>
          <div class="chat-time">${lastActivity}</div>
        </a>
      `;
    });
  }
  
  html += `
          </div>
        </div>
        
        <div class="main-chat">
          <div class="empty-state">
            <div class="empty-state-icon">💎</div>
            <h3>Welcome to Trichy Gold</h3>
            <p>Select a conversation from the sidebar to start chatting</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
  
  res.send(html);
});

// View chat for a mobile - WhatsApp Web Style
app.get("/chat/:mobile", async (req, res) => {
  const mobile = req.params.mobile;
  const lead = await leadsCollection.findOne({ mobile });
  const convo = await messagesCollection.findOne({ mobile }) || { messages: [] };

  if (!lead) {
    return res.status(404).send("Lead not found");
  }

  // Set ultra-strict security headers to prevent all external requests and popups
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: media.twilio.com https://*.twilio.com; media-src 'self' data: https: media.twilio.com https://*.twilio.com; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'self'; connect-src 'self'; font-src 'self'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  let html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: media.twilio.com https://*.twilio.com; media-src 'self' data: https: media.twilio.com https://*.twilio.com; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'self'; connect-src 'self'; font-src 'self'">
      <title>WhatsApp Web - ${lead.name || 'Unknown'}</title>
      ${whatsappWebCSS}
    </head>
    <body>
      <div class="app-container">
        <div class="sidebar">
          <div class="sidebar-header">
            <div>
              <div class="sidebar-title">Trichy Gold Jewellers</div>
              <div class="sidebar-subtitle">Sales Panel</div>
            </div>
          </div>
          
          <div class="chat-list">
  `;

  // Add all leads to sidebar
  const allLeads = await leadsCollection
    .find({ $or: [{ handover: true }, { handover: "true" }] })
    .toArray();
  allLeads.forEach(l => {
    const totalQueries = (l.productQueries?.length || 0) + (l.schemesQueries?.length || 0) + (l.ratesQueries?.length || 0);
    const lastActivity = l.createdAt ? new Date(l.createdAt).toLocaleDateString() : 'Today';
    const initials = l.name ? l.name.charAt(0).toUpperCase() : '?';
    const preview = totalQueries > 0 ? `${totalQueries} queries completed` : 'New conversation';
    const isActive = l.mobile === mobile ? 'active' : '';
    
    html += `
      <a href="/chat/${l.mobile}" class="chat-item ${isActive}">
        <div class="avatar">${initials}</div>
        <div class="chat-info">
          <div class="chat-name">${l.name || 'Unknown Customer'}</div>
          <div class="chat-preview">${preview}</div>
          <div class="chat-stats">
            <span class="stat-badge">P: ${l.productQueries?.length || 0}</span>
            <span class="stat-badge">S: ${l.schemesQueries?.length || 0}</span>
            <span class="stat-badge">R: ${l.ratesQueries?.length || 0}</span>
          </div>
        </div>
        <div class="chat-time">${lastActivity}</div>
      </a>
    `;
  });

  html += `
          </div>
        </div>
        
        <div class="main-chat">
          <div class="chat-header">
            <div class="chat-header-left">
              <a href="/panel" class="back-btn">←</a>
              <div class="chat-header-info">
                <h2>${lead.name || 'Unknown Customer'}</h2>
                <p>${mobile}</p>
              </div>
            </div>
          </div>
          
          <div class="chat-messages">
  `;

  // Display Product Queries
  if (lead.productQueries?.length > 0) {
    lead.productQueries.forEach((query, index) => {
      html += `
        <div class="message-group">
          <div class="message-group-title">
            <span>Product Query #${query.id} - ${query.productInterested}</span>
          </div>
      `;
      
      query.details.forEach(d => {
        const time = new Date(d.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        if (d.type === "text") {
          html += `
            <div class="message-bubble customer">
              <div class="message-content">
                <div class="message-text">${d.content}</div>
                <div class="message-time">${time}</div>
              </div>
            </div>
          `;
        } else if (d.type === "image") {
          html += `
            <div class="message-bubble customer">
              <div class="message-content">
                <img src="${d.content}" class="message-image" alt="Image">
                <div class="message-time">${time}</div>
              </div>
            </div>
          `;
        } else if (d.type === "voice") {
          html += `
            <div class="message-bubble customer">
              <div class="message-content">
                <audio controls class="message-audio">
                  <source src="${d.content}" type="audio/mpeg">
                </audio>
                <div class="message-time">${time}</div>
              </div>
            </div>
          `;
        }
      });
      
      html += `</div>`;
    });
  }

  // Display Schemes Queries
  if (lead.schemesQueries?.length > 0) {
    lead.schemesQueries.forEach((query, index) => {
      html += `
        <div class="message-group">
          <div class="message-group-title">
            <span>Schemes Query #${query.id}</span>
          </div>
      `;
      
      query.details.forEach(d => {
        const time = new Date(d.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        if (d.type === "text") {
          html += `
            <div class="message-bubble customer">
              <div class="message-content">
                <div class="message-text">${d.content}</div>
                <div class="message-time">${time}</div>
              </div>
            </div>
          `;
        } else if (d.type === "image") {
          html += `
            <div class="message-bubble customer">
              <div class="message-content">
                <img src="${d.content}" class="message-image" alt="Image">
                <div class="message-time">${time}</div>
              </div>
            </div>
          `;
        } else if (d.type === "voice") {
          html += `
            <div class="message-bubble customer">
              <div class="message-content">
                <audio controls class="message-audio">
                  <source src="${d.content}" type="audio/mpeg">
                </audio>
                <div class="message-time">${time}</div>
              </div>
            </div>
          `;
        }
      });
      
      html += `</div>`;
    });
  }

  // Display Rates Queries
  if (lead.ratesQueries?.length > 0) {
    lead.ratesQueries.forEach((query, index) => {
      html += `
        <div class="message-group">
          <div class="message-group-title">
            <span>Rates Query #${query.id}</span>
          </div>
      `;
      
      query.details.forEach(d => {
        const time = new Date(d.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        if (d.type === "text") {
          html += `
            <div class="message-bubble customer">
              <div class="message-content">
                <div class="message-text">${d.content}</div>
                <div class="message-time">${time}</div>
              </div>
            </div>
          `;
        } else if (d.type === "image") {
          html += `
            <div class="message-bubble customer">
              <div class="message-content">
                <img src="${d.content}" class="message-image" alt="Image">
                <div class="message-time">${time}</div>
              </div>
            </div>
          `;
        } else if (d.type === "voice") {
          html += `
            <div class="message-bubble customer">
              <div class="message-content">
                <audio controls class="message-audio">
                  <source src="${d.content}" type="audio/mpeg">
                </audio>
                <div class="message-time">${time}</div>
              </div>
            </div>
          `;
        }
      });
      
      html += `</div>`;
    });
  }

  // Display Post-Handover Messages
  if (convo.messages?.length > 0) {
    html += `
      <div class="message-group">
        <div class="message-group-title">
          <span>Live Chat</span>
        </div>
    `;
    
    convo.messages.forEach(m => {
      const time = new Date(m.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      const bubbleClass = m.from === "customer" ? "customer" : "salesperson";
      if (m.type === "text") {
        html += `
          <div class="message-bubble ${bubbleClass}">
            <div class="message-content">
              <div class="message-text">${m.content}</div>
              <div class="message-time">${time}</div>
            </div>
          </div>
        `;
      } else if (m.type === "image") {
        html += `
          <div class="message-bubble ${bubbleClass}">
            <div class="message-content">
              <img src="${m.content}" class="message-image" alt="Image">
              <div class="message-time">${time}</div>
            </div>
          </div>
        `;
      } else if (m.type === "voice") {
        html += `
          <div class="message-bubble ${bubbleClass}">
            <div class="message-content">
              <audio controls class="message-audio">
                <source src="${m.content}" type="audio/mpeg">
              </audio>
              <div class="message-time">${time}</div>
            </div>
          </div>
        `;
      }
    });
    
    html += `</div>`;
  }

  html += `
          </div>
          
          <div class="reply-container">
            <form method="POST" action="/reply/${mobile}" class="reply-form">
              <textarea name="message" placeholder="Type a message" class="message-input" required></textarea>
              <button type="submit" class="send-button">
                <svg viewBox="0 0 24 24">
                  <path d="M1.101 21.757L23.8 12.028 1.101 2.3l.011 7.912 13.623 1.816-13.623 1.817-.011 7.912z"/>
                </svg>
              </button>
            </form>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
  
  res.send(html);
});

// Send reply from panel
app.post("/reply/:mobile", async (req, res) => {
  const mobile = req.params.mobile;
  const message = req.body.message;

  // Store in messages
  await messagesCollection.updateOne(
    { mobile },
    { $push: { messages: { from: "salesperson", type: "text", content: message, timestamp: new Date() } } },
    { upsert: true }
  );

  // Send via Twilio
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: mobile,
    body: message
  });

  res.redirect(`/chat/${mobile}`);
});

// Test route
app.get("/whatsapp-webhook", (req, res) => {
  console.log("✅ Webhook endpoint is accessible!");
  res.send("Webhook endpoint is working!");
});


// ✅ Connect DB first so webhooks never hit undefined leadsCollection
async function start() {
  try {
    await mongo.connect();
    leadsCollection = mongo.db("jewelleryCRM").collection("leads");
    messagesCollection = mongo.db("jewelleryCRM").collection("messages");
    const fixTrue = await leadsCollection.updateMany(
      { handover: "true" },
      { $set: { handover: true } }
    );
    const fixFalse = await leadsCollection.updateMany(
      { handover: "false" },
      { $set: { handover: false } }
    );
    if (fixTrue.modifiedCount > 0 || fixFalse.modifiedCount > 0) {
      console.log(
        `✅ Normalized handover field types (${fixTrue.modifiedCount} true, ${fixFalse.modifiedCount} false)`
      );
    }
    const na = await leadsCollection.updateMany(
      { productQueries: null },
      { $set: { productQueries: [] } }
    );
    const ns = await leadsCollection.updateMany(
      { schemesQueries: null },
      { $set: { schemesQueries: [] } }
    );
    const nr = await leadsCollection.updateMany(
      { ratesQueries: null },
      { $set: { ratesQueries: [] } }
    );
    if (na.modifiedCount + ns.modifiedCount + nr.modifiedCount > 0) {
      console.log(
        `✅ Normalized null query arrays → [] (${na.modifiedCount + ns.modifiedCount + nr.modifiedCount} leads)`
      );
    }
    console.log("✅ MongoDB connected");
  } catch (e) {
    console.error("❌ MongoDB connection failed:", e.message);
    process.exit(1);
  }

  const wn = process.env.TWILIO_WHATSAPP_NUMBER || "";
  if (!wn.startsWith("whatsapp:")) {
    console.warn(
      "⚠️  TWILIO_WHATSAPP_NUMBER should look like whatsapp:+14155238886 (include whatsapp: prefix for WhatsApp)."
    );
  } else {
    console.log("📞 Outbound WhatsApp From:", wn);
  }
  console.log("💡 Stuck with no bot replies? WhatsApp: type menu or reset — or you chose 4 (handover).");

  const port = Number.parseInt(process.env.PORT || "3000", 10);
  const host = process.env.HOST || "0.0.0.0";

  app.listen(port, host, () => {
    console.log(`✅ Server running on http://${host}:${port}`);

    const publicBaseUrl = getPublicBaseUrl();
    if (publicBaseUrl) {
      console.log(`🌐 Public URL: ${publicBaseUrl}`);
      console.log(`📱 Webhook URL: ${publicBaseUrl}/whatsapp-webhook`);
      console.log(`🖥️ Panel URL: ${publicBaseUrl}/panel`);
      console.log(`\n📋 Copy webhook to Twilio: ${publicBaseUrl}/whatsapp-webhook`);
    } else {
      console.log(
        "ℹ️  PUBLIC_URL not set. On Railway, add PUBLIC_URL=https://<your-app>.up.railway.app (or set a custom domain) to print webhook URLs."
      );
    }
  });
}

start();