import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

async function clearDatabase() {
  try {
    console.log("🔍 Connecting to MongoDB...");
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("MONGO_URI is not set");
    const client = new MongoClient(uri);
    await client.connect();
    console.log("✅ Connected to MongoDB!");
    
    const db = client.db("jewelleryCRM");
    
    // Clear leads collection
    const leadsResult = await db.collection("leads").deleteMany({});
    console.log(`🗑️ Cleared ${leadsResult.deletedCount} leads`);
    
    // Clear messages collection
    const messagesResult = await db.collection("messages").deleteMany({});
    console.log(`🗑️ Cleared ${messagesResult.deletedCount} message threads`);
    
    // Verify collections are empty
    const remainingLeads = await db.collection("leads").countDocuments();
    const remainingMessages = await db.collection("messages").countDocuments();
    
    console.log("\n📊 Database Status:");
    console.log(`- Remaining leads: ${remainingLeads}`);
    console.log(`- Remaining message threads: ${remainingMessages}`);
    
    if (remainingLeads === 0 && remainingMessages === 0) {
      console.log("\n✅ Database cleared successfully!");
      console.log("🚀 Ready for fresh testing!");
    } else {
      console.log("\n⚠️ Some records may still exist");
    }
    
    await client.close();
    
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.log("\n   Possible solutions:");
    console.log("1. Verify MONGO_URI in your .env / Railway variables");
    console.log("2. If using Atlas, make sure your IP access list allows this environment");
    console.log("3. If using local MongoDB, ensure it's running and MONGO_URI points to it");
  }
}

// Confirmation prompt
console.log("⚠️ WARNING: This will delete ALL leads and messages!");
console.log("Are you sure you want to clear the database?");
console.log("Press Ctrl+C to cancel, or run the script to continue...");

// Small delay to allow user to cancel
setTimeout(() => {
  clearDatabase();
}, 2000);