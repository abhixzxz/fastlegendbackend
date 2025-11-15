import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";

dotenv.config();

const app = express();
app.disable("x-powered-by");

//hello world
app.get("/", (req, res) => {
  res.json({ success: true, message: "SERVER IS RUNNING SUCCESSFULLY 🌍" });
});

const corsOptions = {
  origin: process.env.CLIENT_ORIGIN || "http://localhost:3000",
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.use(express.json());

const uri = process.env.MONGO_URI || process.env.url;
if (!uri) {
  console.error("Missing MongoDB connection string in env: MONGO_URI or url");
  process.exit(1);
}

let client;
let db;
let users;

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((v) => {
    const idx = v.indexOf("=");
    if (idx > -1) {
      const k = v.slice(0, idx).trim();
      const val = decodeURIComponent(v.slice(idx + 1));
      if (k) out[k] = val;
    }
  });
  return out;
}

async function init() {
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    db = client.db(process.env.DB_NAME || "fastlegend");
    users = db.collection("users");
    await users.createIndex({ username: 1 }, { unique: true });
    await users.createIndex({ mobileNumber: 1 }, { unique: true });
    console.log("MongoDB connected and indexes ensured");
  } catch (err) {
    console.error("MongoDB connection failed", err);
    process.exit(1);
  }
}

app.get("/", (req, res) => {
  res.json({ success: true, message: "Server vibes are good! 😄" });
});

app.get("/api/session", async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const uid = cookies["fastlegend_uid"];
    if (!uid) return res.json({ loggedIn: false });
    const user = await users.findOne(
      { _id: new ObjectId(uid) },
      { projection: { username: 1, country: 1 } }
    );
    if (!user) return res.json({ loggedIn: false });
    return res.json({
      loggedIn: true,
      user: {
        id: user._id.toString(),
        username: user.username,
        country: user.country || "",
      },
    });
  } catch (e) {
    return res.status(500).json({ error: "session_check_failed" });
  }
});

app.post("/api/users", async (req, res) => {
  try {
    const { username, mobileNumber, country } = req.body || {};
    if (!username || !mobileNumber) {
      return res.status(400).json({ error: "username_and_mobile_required" });
    }

    const byMobile = await users.findOne({ mobileNumber });
    if (byMobile && byMobile.username !== username) {
      return res.status(409).json({ error: "mobile_already_registered" });
    }

    const existing = await users.findOne({ username });
    if (existing) {
      if (byMobile && existing._id.toString() !== byMobile._id.toString()) {
        return res.status(409).json({ error: "conflict_detected" });
      }
      await users.updateOne(
        { _id: existing._id },
        { $set: { mobileNumber, country } }
      );
      res.cookie("fastlegend_uid", existing._id.toString(), {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 24 * 365,
      });
      return res.json({
        id: existing._id.toString(),
        username,
        country: country || "",
      });
    }

    const now = new Date();
    const doc = {
      username,
      mobileNumber,
      country: country || "",
      wpm: 0,
      accuracy: 0,
      testsCompleted: 0,
      bestTime: 60,
      joinDate: now.toISOString().split("T")[0],
      createdAt: now,
    };
    const result = await users.insertOne(doc);
    res.cookie("fastlegend_uid", result.insertedId.toString(), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });
    return res.status(201).json({
      id: result.insertedId.toString(),
      username,
      country: doc.country,
    });
  } catch (e) {
    if (e?.code === 11000) {
      return res.status(409).json({ error: "duplicate_key" });
    }
    return res.status(500).json({ error: "user_creation_failed" });
  }
});

app.put("/api/users/stats", async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const uid = cookies["fastlegend_uid"];
    if (!uid) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const { wpm, accuracy, time } = req.body;
    if (typeof wpm !== "number" || typeof accuracy !== "number") {
      return res.status(400).json({ error: "invalid_stats" });
    }

    const user = await users.findOne({ _id: new ObjectId(uid) });
    if (!user) {
      return res.status(404).json({ error: "user_not_found" });
    }

    // Update user stats
    const updateData = {
      testsCompleted: (user.testsCompleted || 0) + 1,
      wpm: Math.max(user.wpm || 0, wpm), // Store best WPM
      accuracy: Math.max(user.accuracy || 0, accuracy), // Store best accuracy
    };

    // Update best time if provided and better
    if (typeof time === "number" && time > 0) {
      updateData.bestTime = Math.min(user.bestTime || 60, time);
    }

    await users.updateOne({ _id: new ObjectId(uid) }, { $set: updateData });

    return res.json({ success: true });
  } catch (e) {
    console.error("Update stats error:", e);
    return res.status(500).json({ error: "stats_update_failed" });
  }
});

app.get("/api/leaderboard", async (req, res) => {
  try {
    const top = await users
      .find(
        { wpm: { $gt: 0 } }, // Only users with WPM > 0
        {
          projection: {
            username: 1,
            country: 1,
            wpm: 1,
            accuracy: 1,
            testsCompleted: 1,
            bestTime: 1,
            joinDate: 1,
          },
        }
      )
      .sort({ wpm: -1 })
      .limit(50)
      .toArray();
    const data = top.map((u, idx) => ({
      id: u._id.toString(),
      name: u.username,
      location: u.country || "",
      wpm: u.wpm || 0,
      accuracy: u.accuracy || 0,
      testsCompleted: u.testsCompleted || 0,
      bestTime: u.bestTime || 60,
      joinDate: u.joinDate || "",
      rank: idx + 1,
    }));
    return res.json({ entries: data });
  } catch (e) {
    return res.status(500).json({ error: "leaderboard_fetch_failed" });
  }
});

const PORT = process.env.PORT || 5000;
init().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is running at 99 http://localhost:${PORT}`);
  });
});
