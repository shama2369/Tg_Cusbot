import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

async function checkDatabase() {
  try {
    console.log("🔍 Connecting to MongoDB...");
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("MONGO_URI is not set");
    const client = new MongoClient(uri);
    await client.connect();
    console.log("✅ Connected to MongoDB!");
    
    const db = client.db("jewellerybot");
    
    // Check leads collection
    const leads = await db.collection("leads").find({}).toArray();
    console.log(`📊 Total leads: ${leads.length}`);
    
    if (leads.length > 0) {
      console.log("\n📋 Recent leads:");
      leads.slice(-5).forEach((lead, index) => {
        console.log(`${index + 1}. Mobile: ${lead.mobile}`);
        console.log(`   Name: ${lead.name || 'N/A'}`);
        console.log(`   Product: ${lead.productInterested || 'N/A'}`);
        console.log(`   Type: ${lead.typeofquery || 'N/A'}`);
        console.log(`   Handover: ${lead.handover ? 'Yes' : 'No'}`);
        console.log(`   State: ${lead.state || 'N/A'}`);
        console.log(`   Created: ${lead.createdAt || 'N/A'}`);
        console.log(`   Details: ${lead.details ? lead.details.length : 0} items`);
        console.log("   ---");
      });
    }
    
    // Check messages collection
    const messages = await db.collection("messages").find({}).toArray();
    console.log(`📊 Total message threads: ${messages.length}`);
    
    if (messages.length > 0) {
      console.log("\n💬 Recent message threads:");
      messages.slice(-3).forEach((msg, index) => {
        console.log(`${index + 1}. Mobile: ${msg.mobile}`);
        console.log(`   Messages: ${msg.messages ? msg.messages.length : 0} total`);
        if (msg.messages && msg.messages.length > 0) {
          const lastMessage = msg.messages[msg.messages.length - 1];
          console.log(`   Last: ${lastMessage.from} - ${lastMessage.type} - ${lastMessage.content?.substring(0, 50)}...`);
        }
        console.log("   ---");
      });
    }
    
    // Summary statistics
    console.log("\n📈 Summary:");
    const handoverLeads = leads.filter(lead => lead.handover === true);
    const activeLeads = leads.filter(lead => lead.handover === false);
    
    console.log(`- Total leads: ${leads.length}`);
    console.log(`- Handed over: ${handoverLeads.length}`);
    console.log(`- Active: ${activeLeads.length}`);
    console.log(`- Message threads: ${messages.length}`);
    
    await client.close();
    console.log("\n✅ Database check completed!");
    
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.log("\n💡 Possible solutions:");
    console.log("1. Verify MONGO_URI in your .env / Railway variables");
    console.log("2. If using Atlas, make sure your IP access list allows this environment");
    console.log("3. If using local MongoDB, ensure it's running and MONGO_URI points to it");
  }
}

checkDatabase();
