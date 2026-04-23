import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Stripe from "stripe";
import OpenAI from "openai";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ── Email helper (nodemailer — works with any SMTP: Gmail, Postmark, Resend) ──
async function sendEmail({ to, subject, html, text }) {
  if (!process.env.SMTP_HOST && !process.env.SMTP_USER) {
    console.log("[Email] SMTP not configured. Would send to:", to, "—", subject);
    return;
  }
  const nodemailer = (await import("nodemailer")).default;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to, subject, html, text,
  });
  console.log("[Email] Sent to:", to);
}
app.set('trust proxy', 1);

// Lazy init — don't crash on startup if keys are missing.
// Auth, tasks, habits all work without Stripe or OpenAI.
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}
function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── MongoDB connection ────────────────────────────────────────────────────────
if (!process.env.MONGO_URI) {
  console.error("[DB] MONGO_URI not set — database features will fail. Set it in Replit Secrets.");
} else {
  mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("[DB] MongoDB connected"))
    .catch(e => console.error("[DB] MongoDB connection error:", e.message));
}

// ── Schemas ───────────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  username: { type: String, required: true, unique: true, uppercase: true, trim: true },
  password: { type: String, required: true },
  xp: { type: Number, default: 0 },
  totalXP: { type: Number, default: 0 },
  weeklyPoints: { type: Number, default: 0 },
  streak: { type: Number, default: 0 },
  lastCompletedDate: String,
  isPro: { type: Boolean, default: false },
  plan: { type: String, default: "free" },
  stripeCustomerId: String,
  stripeSubscriptionId: String,
  onboardingCompleted: { type: Boolean, default: false },
  isDemo: { type: Boolean, default: false },
  unlockedBadges: [String],
  disciplineScore: { type: Number, default: 0 },
  referralCode: String,
  // AI preferences
  coachStyle: { type: String, enum: ["spartan", "motivational", "chill"], default: "spartan" },
  responseLength: { type: String, enum: ["short", "medium", "detailed"], default: "medium" },
  // Notification preferences
  dailyReminders: { type: Boolean, default: true },
  disciplineAlerts: { type: Boolean, default: true },
  // Daily coach message tracking
  coachMessagesUsed: { type: Number, default: 0 },
  coachMessagesDate: { type: String, default: "" },
  // Tier (free | standard | pro) — distinguishes Standard $10 vs Pro $15
  tier: { type: String, enum: ["free", "standard", "pro"], default: "free" },
  // Streak insurance (Pro) — freezes per week + last used date
  streakFreezeCount: { type: Number, default: 1 },   // resets every Monday
  streakFreezeWeek:  { type: String, default: "" },   // ISO week: "2025-W23"
  streakFreezeUsed:  { type: Boolean, default: false },
  // Push notification subscription endpoint
  pushSubscription: { type: Object, default: null },
  // Password reset
  resetToken:        { type: String, default: null },
  resetTokenExpiry:  { type: Date,   default: null },
  // AI coach memory (rolling summary for Pro users)
  coachMemory:       { type: String, default: "" },
  // Friends (array of User ObjectIds)
  friends:           [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  // Admin flag
  isAdmin: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const TaskSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  title: { type: String, required: true },
  name: String,
  difficulty: { type: String, enum: ["Easy", "Medium", "Hard"], default: "Medium" },
  completed: { type: Boolean, default: false },
  proofRequired: { type: Boolean, default: false },
  date: { type: String, default: () => new Date().toISOString().split("T")[0] },
  xpEarned: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

const HabitSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  title: { type: String, required: true },
  icon: { type: String, default: "⚡" },
  category: { type: String, default: "general" },
  streak: { type: Number, default: 0 },
  completedToday: { type: Boolean, default: false },
  lastLogDate: String,
  createdAt: { type: Date, default: Date.now },
});

const NotificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  message: String,
  read: { type: Boolean, default: false },
  date: { type: Date, default: Date.now },
});

const User = mongoose.model("User", UserSchema);
const Task = mongoose.model("Task", TaskSchema);
const Habit = mongoose.model("Habit", HabitSchema);
const Notification = mongoose.model("Notification", NotificationSchema);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use("/api/webhook", express.raw({ type: "application/json" }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const authLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20 });
app.use(limiter);

// ── Auth helpers ──────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret_change_me";

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "7d" });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return res.status(401).json({ error: "No token" });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Token invalid", code: "TOKEN_EXPIRED" });
  }
}

const XP_TABLE = { Hard: 50, Medium: 25, Easy: 10 };
function today() { return new Date().toISOString().split("T")[0]; }
function yesterday() { return new Date(Date.now() - 86400000).toISOString().split("T")[0]; }

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", app: "Don't Quit Backend" }));
app.get("/api/health", (req, res) => {
  const dbState = ["disconnected","connected","connecting","disconnecting"][mongoose.connection.readyState] || "unknown";
  res.json({
    status: "ok",
    db:          dbState,
    mongoUri:    process.env.MONGO_URI    ? "set" : "MISSING",
    jwtSecret:   process.env.JWT_SECRET   ? "set" : "using default (change in prod)",
    openai:      process.env.OPENAI_API_KEY ? "set" : "MISSING",
    stripe:      process.env.STRIPE_SECRET_KEY ? "set" : "MISSING",
    ts:          new Date().toISOString(),
  });
});

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) return res.status(400).json({ error: "All fields required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const existingEmail = await User.findOne({ email: email.toLowerCase() });
    if (existingEmail) return res.status(409).json({ error: "Email already registered" });

    const existingUsername = await User.findOne({ username: username.toUpperCase() });
    if (existingUsername) return res.status(409).json({ error: "Username already taken" });

    const hashed = await bcrypt.hash(password, 12);
    const referralCode = Math.random().toString(36).slice(2, 8).toUpperCase();
    const user = await User.create({
      email: email.toLowerCase(),
      username: username.toUpperCase(),
      password: hashed,
      referralCode,
    });

    // Seed starter habits
    await Habit.insertMany([
      { userId: user._id, title: "Cold Shower", icon: "🧊", category: "fitness", streak: 0 },
      { userId: user._id, title: "Meditation", icon: "🧘", category: "mindset", streak: 0 },
      { userId: user._id, title: "Read 30min", icon: "📚", category: "knowledge", streak: 0 },
    ]);

    const token = signToken(user._id);
    const { password: _, ...safe } = user.toObject();
    res.json({ success: true, accessToken: token, user: safe });
  } catch (err) {
    console.error("Register error:", err.message);
    if (err.name === "MongooseError" || err.name === "MongoServerError") {
      return res.status(503).json({ error: "Database not connected. Check MONGO_URI in Replit Secrets." });
    }
    res.status(500).json({ error: "Registration failed: " + err.message });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid email or password" });

    // FIX #6: Reset streak if user missed a day
    if (user.lastCompletedDate && user.lastCompletedDate < yesterday()) {
      user.streak = 0;
    }
    await user.save();

    const token = signToken(user._id);
    const { password: _, ...safe } = user.toObject();
    res.json({ success: true, accessToken: token, user: safe });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/auth/demo", async (req, res) => {
  try {
    let demo = await User.findOne({ email: "demo@dontquit.app" });
    if (!demo) {
      const hashed = await bcrypt.hash("demo1234", 12);
      demo = await User.create({
        email: "demo@dontquit.app", username: "WARRIOR", password: hashed,
        xp: 120, totalXP: 340, weeklyPoints: 85, streak: 3, isDemo: true,
        onboardingCompleted: true,
      });
      await Habit.insertMany([
        { userId: demo._id, title: "Cold Shower", icon: "🧊", streak: 3, category: "fitness" },
        { userId: demo._id, title: "Meditation", icon: "🧘", streak: 7, category: "mindset" },
        { userId: demo._id, title: "Read 30min", icon: "📚", streak: 12, category: "knowledge" },
      ]);
    }

    // FIX #2: Always re-seed today's demo tasks so they exist every day
    await Task.deleteMany({ userId: demo._id, date: today() });
    await Task.insertMany([
      { userId: demo._id, title: "Cold shower — 3 min", name: "Cold shower — 3 min", difficulty: "Hard", date: today() },
      { userId: demo._id, title: "5KM morning run", name: "5KM morning run", difficulty: "Hard", date: today() },
      { userId: demo._id, title: "2hr deep work block", name: "2hr deep work block", difficulty: "Medium", date: today() },
    ]);

    const token = signToken(demo._id);
    const { password: _, ...safe } = demo.toObject();
    res.json({ success: true, accessToken: token, user: { ...safe, isDemo: true } });
  } catch (err) {
    console.error("Demo error:", e.message);
    res.status(500).json({ error: "Demo failed: " + e.message });
  }
});

app.post("/api/auth/refresh", (req, res) => {
  res.json({ success: true });
});

app.post("/api/auth/logout", (req, res) => {
  res.json({ success: true });
});

app.post("/api/auth/forgot-password", async (req, res) => {
  res.json({ success: true, message: "If this email exists, a reset link was sent." });
  try {
    const { email } = req.body;
    if (!email) return;
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return; // don't reveal whether email exists
    const crypto = await import("crypto");
    const token = crypto.default.randomBytes(32).toString("hex");
    user.resetToken = token;
    user.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();
    const resetUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/reset-password/${token}`;
    await sendEmail({
      to: user.email,
      subject: "Reset your Don't Quit password",
      html: `<p>Hi ${user.username},</p><p>Reset your password: <a href="${resetUrl}">${resetUrl}</a></p><p>Link expires in 1 hour.</p>`,
      text: `Reset your password: ${resetUrl}`,
    });
  } catch (e) { console.error("Forgot password error:", e.message); }
});

app.post("/api/auth/reset-password/:token", async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: "Password must be 8+ characters" });
    const user = await User.findOne({
      resetToken: req.params.token,
      resetTokenExpiry: { $gt: new Date() },
    });
    if (!user) return res.status(400).json({ error: "Invalid or expired reset link" });
    user.password = await bcrypt.hash(password, 12);
    user.resetToken = null;
    user.resetTokenExpiry = null;
    await user.save();
    const token = signToken(user._id);
    const { password: _, ...safe } = user.toObject();
    res.json({ success: true, accessToken: token, user: safe });
  } catch (e) { res.status(500).json({ error: "Reset failed" }); }
});

app.post("/api/auth/resend-verification", (req, res) => res.json({ success: true }));
app.get("/api/auth/verify-email/:token", (req, res) => res.json({ success: true }));
app.get("/api/auth/2fa/setup", authMiddleware, (req, res) => res.json({ qrCode: "", secret: "" }));
app.post("/api/auth/2fa/confirm", authMiddleware, (req, res) => res.json({ success: true }));
app.post("/api/auth/2fa/disable", authMiddleware, (req, res) => res.json({ success: true }));
app.post("/api/auth/2fa/verify", (req, res) => res.json({ success: true }));

// ── Tasks ─────────────────────────────────────────────────────────────────────
app.get("/api/tasks", authMiddleware, async (req, res) => {
  try {
    const tasks = await Task.find({ userId: req.userId, date: today() }).sort({ createdAt: 1 });
    res.json({ tasks });
  } catch (err) { res.status(500).json({ error: "Failed to fetch tasks" }); }
});

app.post("/api/tasks", authMiddleware, async (req, res) => {
  try {
    const { title, name, difficulty = "Medium", proofRequired = false } = req.body;
    const label = (title || name || "").trim();
    if (!label) return res.status(400).json({ error: "Task name required" });
    const task = await Task.create({ userId: req.userId, title: label, name: label, difficulty, proofRequired, date: today() });
    const tasks = await Task.find({ userId: req.userId, date: today() });
    res.json({ success: true, task, tasks });
  } catch (err) { res.status(500).json({ error: "Failed to create task" }); }
});

app.post("/api/tasks/:id/complete", authMiddleware, async (req, res) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, userId: req.userId });
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.completed) return res.status(409).json({ error: "Already completed" });

    const xp = XP_TABLE[task.difficulty] || 10;
    task.completed = true;
    task.xpEarned = xp;
    await task.save();

    const user = await User.findById(req.userId);
    user.xp += xp;
    user.totalXP += xp;
    user.weeklyPoints += xp;

    const todayStr = today();
    const todayTasks = await Task.find({ userId: req.userId, date: todayStr });
    const allDone = todayTasks.length > 0 && todayTasks.every(t => t.completed);
    if (allDone && user.lastCompletedDate !== todayStr) {
      user.streak += 1;
      user.lastCompletedDate = todayStr;
    }
    await user.save();
    res.json({ success: true, xpGained: xp, newXP: user.xp, newTotalXP: user.totalXP, newWeeklyPoints: user.weeklyPoints, streak: user.streak });
  } catch (err) { res.status(500).json({ error: "Failed to complete task" }); }
});

app.post("/api/tasks/:id/uncomplete", authMiddleware, async (req, res) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, userId: req.userId });
    if (!task) return res.status(404).json({ error: "Task not found" });
    const xp = task.xpEarned || 0;
    task.completed = false;
    task.xpEarned = 0;
    await task.save();
    const user = await User.findById(req.userId);
    user.xp = Math.max(0, user.xp - xp);
    user.totalXP = Math.max(0, user.totalXP - xp);
    user.weeklyPoints = Math.max(0, user.weeklyPoints - xp);
    await user.save();
    res.json({ success: true, newXP: user.xp, newTotalXP: user.totalXP, newWeeklyPoints: user.weeklyPoints });
  } catch (err) { res.status(500).json({ error: "Failed to uncomplete task" }); }
});

app.post("/api/tasks/embedded", authMiddleware, async (req, res) => {
  try {
    const { title } = req.body;
    const task = await Task.create({ userId: req.userId, title: title || "Task", name: title || "Task", difficulty: "Medium", date: today() });
    res.json({ success: true, task });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.post("/api/tasks/embedded/:index/complete", authMiddleware, async (req, res) => {
  try {
    const tasks = await Task.find({ userId: req.userId, date: today() }).sort({ createdAt: 1 });
    const idx = parseInt(req.params.index);
    const task = tasks[idx];
    if (!task || task.completed) return res.json({ success: true, xpGained: 0 });
    const xp = XP_TABLE[task.difficulty] || 10;
    task.completed = true; task.xpEarned = xp;
    await task.save();
    const user = await User.findById(req.userId);
    user.xp += xp; user.totalXP += xp; user.weeklyPoints += xp;
    user.disciplineScore = Math.min(100, (user.disciplineScore || 0) + 5);
    await user.save();
    res.json({ success: true, xpGained: xp, disciplineScore: user.disciplineScore });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.get("/api/tasks/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password");
    const tasks = await Task.find({ userId: req.userId, date: today() });
    res.json({ user, tasks, streak: user?.streak || 0, disciplineScore: user?.disciplineScore || 0 });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.delete("/api/tasks/:id", authMiddleware, async (req, res) => {
  try {
    const task = await Task.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.completed && task.xpEarned) {
      const user = await User.findById(req.userId);
      user.xp = Math.max(0, user.xp - task.xpEarned);
      user.totalXP = Math.max(0, user.totalXP - task.xpEarned);
      user.weeklyPoints = Math.max(0, user.weeklyPoints - task.xpEarned);
      await user.save();
    }
    const tasks = await Task.find({ userId: req.userId, date: today() });
    res.json({ success: true, tasks });
  } catch (err) { res.status(500).json({ error: "Failed to delete task" }); }
});

app.post("/api/tasks/complete-all", authMiddleware, async (req, res) => {
  try {
    const todayStr = today();
    const pending = await Task.find({ userId: req.userId, date: todayStr, completed: false });
    let totalXp = 0;
    for (const task of pending) {
      const xp = XP_TABLE[task.difficulty] || 10;
      task.completed = true;
      task.xpEarned = xp;
      totalXp += xp;
      await task.save();
    }
    const user = await User.findById(req.userId);
    user.xp += totalXp;
    user.totalXP += totalXp;
    user.weeklyPoints += totalXp;
    const allTasks = await Task.find({ userId: req.userId, date: todayStr });
    const allDone = allTasks.length > 0 && allTasks.every(t => t.completed);
    if (allDone && user.lastCompletedDate !== todayStr) {
      user.streak += 1;
      user.lastCompletedDate = todayStr;
    }
    await user.save();
    res.json({ success: true, xpGained: totalXp, newXP: user.xp, newTotalXP: user.totalXP, newWeeklyPoints: user.weeklyPoints, streak: user.streak, tasks: allTasks });
  } catch (err) { res.status(500).json({ error: "Failed to complete all tasks" }); }
});

app.post("/api/auth/change-password", authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "Both passwords required" });
    if (newPassword.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });
    const user = await User.findById(req.userId);
    if (!user || !user.password) return res.status(400).json({ error: "Cannot change password for this account" });
    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.status(401).json({ error: "Current password incorrect" });
    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed to change password" }); }
});

app.post("/api/tasks/challenge", authMiddleware, (req, res) => res.json({ success: true, challenge: {} }));
app.post("/api/tasks/challenge/:id/accept", authMiddleware, (req, res) => res.json({ success: true }));
app.post("/api/tasks/challenge/:id/decline", authMiddleware, (req, res) => res.json({ success: true }));
app.post("/api/tasks/challenge/:id/complete", authMiddleware, (req, res) => res.json({ success: true, xpGained: 50 }));

// ── Habits ────────────────────────────────────────────────────────────────────
app.get("/api/habits", authMiddleware, async (req, res) => {
  try {
    const habits = await Habit.find({ userId: req.userId }).sort({ createdAt: 1 });
    const todayStr = today();
    // FIX #5: persist the completedToday reset to DB so it survives page refresh
    const updates = habits.map(async (h) => {
      if (h.lastLogDate !== todayStr && h.completedToday) {
        h.completedToday = false;
        await h.save();
      }
      return h;
    });
    const updated = await Promise.all(updates);
    res.json({ habits: updated });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.post("/api/habits", authMiddleware, async (req, res) => {
  try {
    const { title, icon, category } = req.body;
    const habit = await Habit.create({ userId: req.userId, title, icon: icon || "⚡", category: category || "general" });
    res.json({ success: true, habit });
  } catch (err) { res.status(500).json({ error: "Failed to create habit" }); }
});

app.post("/api/habits/:id/log", authMiddleware, async (req, res) => {
  try {
    const habit = await Habit.findOne({ _id: req.params.id, userId: req.userId });
    if (!habit) return res.status(404).json({ error: "Habit not found" });
    const todayStr = today();
    if (habit.lastLogDate === todayStr) {
      habit.completedToday = false;
      habit.streak = Math.max(0, habit.streak - 1);
      habit.lastLogDate = null;
    } else {
      habit.completedToday = true;
      habit.streak += 1;
      habit.lastLogDate = todayStr;
    }
    await habit.save();
    res.json({ success: true, habit });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.patch("/api/habits/:id", authMiddleware, async (req, res) => {
  try {
    const habit = await Habit.findOneAndUpdate({ _id: req.params.id, userId: req.userId }, req.body, { new: true });
    res.json({ success: true, habit });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.delete("/api/habits/:id", authMiddleware, async (req, res) => {
  try {
    await Habit.deleteOne({ _id: req.params.id, userId: req.userId });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

// ── User / Profile ────────────────────────────────────────────────────────────
app.patch("/api/user/profile", authMiddleware, async (req, res) => {
  try {
    const { username, phone } = req.body;
    const update = {};
    if (username) update.username = username.toUpperCase();
    if (phone) update.phone = phone;
    const user = await User.findByIdAndUpdate(req.userId, update, { new: true }).select("-password");
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

// Allowlisted user-editable preference fields. Anything else in req.body is silently ignored
// to prevent privilege escalation (isPro, plan, coachMessagesUsed, XP, etc).
const PROFILE_ALLOWED_FIELDS = new Set([
  "coachStyle", "responseLength", "dailyReminders", "disciplineAlerts",
  "username", "phone",
]);

app.patch("/api/profile", authMiddleware, async (req, res) => {
  try {
    const update = {};
    for (const k of Object.keys(req.body || {})) {
      if (PROFILE_ALLOWED_FIELDS.has(k)) update[k] = req.body[k];
    }
    if (update.coachStyle && !["spartan","motivational","chill"].includes(update.coachStyle)) {
      return res.status(400).json({ error: "Invalid coachStyle" });
    }
    if (update.responseLength && !["short","medium","detailed"].includes(update.responseLength)) {
      return res.status(400).json({ error: "Invalid responseLength" });
    }
    if (update.username) update.username = String(update.username).toUpperCase().trim();
    const user = await User.findByIdAndUpdate(req.userId, update, { new: true }).select("-password");
    res.json({ success: true, user });
  } catch (err) {
    console.error("Profile patch error:", err);
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/user/stats", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password");
    res.json({ stats: { xp: user.xp, totalXP: user.totalXP, streak: user.streak } });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.get("/api/user/leaderboard", authMiddleware, async (req, res) => {
  try {
    const users = await User.find({}).select("username weeklyPoints totalXP").sort({ weeklyPoints: -1 }).limit(20);
    const leaderboard = users.map((u, i) => ({ rank: i + 1, userId: u._id, username: u.username, weeklyPoints: u.weeklyPoints, totalXP: u.totalXP }));
    res.json({ leaderboard });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

// Search users by username
app.get("/api/user/search", authMiddleware, async (req, res) => {
  try {
    const q = (req.query.q || "").trim().toUpperCase();
    if (q.length < 2) return res.json({ users: [] });
    const users = await User.find({ username: { $regex: q, $options: "i" }, _id: { $ne: req.userId } })
      .select("username totalXP streak _id").limit(10).lean();
    res.json({ users: users.map(u => ({ id: u._id, username: u.username, totalXP: u.totalXP, streak: u.streak })) });
  } catch (e) { res.status(500).json({ error: "Failed" }); }
});

// Send friend request (adds directly — simple bilateral follow)
app.post("/api/user/friends", authMiddleware, async (req, res) => {
  try {
    const { friendId } = req.body;
    if (!friendId) return res.status(400).json({ error: "friendId required" });
    if (friendId === req.userId) return res.status(400).json({ error: "Cannot add yourself" });
    const [me, friend] = await Promise.all([User.findById(req.userId), User.findById(friendId)]);
    if (!friend) return res.status(404).json({ error: "User not found" });
    if (!me.friends.map(id => id.toString()).includes(friendId)) {
      me.friends.push(friendId); await me.save();
    }
    if (!friend.friends.map(id => id.toString()).includes(req.userId)) {
      friend.friends.push(req.userId); await friend.save();
    }
    res.json({ success: true, friend: { id: friend._id, username: friend.username } });
  } catch (e) { res.status(500).json({ error: "Failed" }); }
});

// Remove friend
app.delete("/api/user/friends/:id", authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, { $pull: { friends: req.params.id } });
    await User.findByIdAndUpdate(req.params.id, { $pull: { friends: req.userId } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Failed" }); }
});

// Get friends list with their stats
app.get("/api/user/friends", authMiddleware, async (req, res) => {
  try {
    const me = await User.findById(req.userId).populate("friends", "username totalXP weeklyPoints streak _id").lean();
    res.json({ friends: (me.friends || []).map(f => ({ id: f._id, username: f.username, totalXP: f.totalXP, weeklyPoints: f.weeklyPoints, streak: f.streak })) });
  } catch (e) { res.status(500).json({ error: "Failed" }); }
});

app.post("/api/user/friends/:id/accept", authMiddleware, (req, res) => res.json({ success: true }));
app.post("/api/user/score", authMiddleware, async (req, res) => {
  try {
    const { points } = req.body;
    if (points) await User.findByIdAndUpdate(req.userId, { $inc: { weeklyPoints: points } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.delete("/api/user/account", authMiddleware, async (req, res) => {
  try {
    await User.deleteOne({ _id: req.userId });
    await Task.deleteMany({ userId: req.userId });
    await Habit.deleteMany({ userId: req.userId });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

// ── AI Coach ──────────────────────────────────────────────────────────────────
const FREE_DAILY_LIMIT     = 30;  // free tier
const STANDARD_DAILY_LIMIT = 50;  // standard tier

const STYLE_PROMPTS = {
  spartan: "You are SPARTAN COACH — strict, intense, no-excuses. Direct commands, brutal honesty, military discipline. Push them hard. Never coddle.",
  motivational: "You are MOTIVATIONAL COACH — uplifting, energetic, encouraging. Celebrate wins, frame setbacks as growth. Hype them up but stay grounded.",
  chill: "You are CHILL COACH — calm, understanding, supportive. Speak warmly like a wise friend. No yelling, no pressure — gentle nudges and clarity.",
};

const LENGTH_TOKENS = { short: 120, medium: 300, detailed: 700 };
const LENGTH_GUIDANCE = {
  short: "Keep replies under 40 words. Cut every unnecessary word.",
  medium: "Keep replies under 150 words. Tight, punchy.",
  detailed: "Give thorough, well-structured replies up to 500 words when needed.",
};

app.post("/api/coach/chat", authMiddleware, async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });

    const todayStr = today();

    // Atomic reset-or-init the day counter (no-op when date already matches)
    await User.updateOne(
      { _id: req.userId, coachMessagesDate: { $ne: todayStr } },
      { $set: { coachMessagesUsed: 0, coachMessagesDate: todayStr } }
    );

    // Atomically reserve a slot. For free users: only succeed if used<limit. For pro: always succeed.
    const meta = await User.findById(req.userId).select("isPro tier");
    if (!meta) return res.status(401).json({ error: "User not found" });
    const isProTier      = meta.isPro || meta.tier === "pro";
    const isStandardTier = meta.tier === "standard";
    const dailyLimit     = isProTier ? null : isStandardTier ? STANDARD_DAILY_LIMIT : FREE_DAILY_LIMIT;
    const reserveFilter  = isProTier
      ? { _id: req.userId }
      : { _id: req.userId, coachMessagesUsed: { $lt: dailyLimit } };
    const user = await User.findOneAndUpdate(
      reserveFilter,
      { $inc: { coachMessagesUsed: 1 } },
      { new: true, select: "-password" }
    );
    if (!user) {
      return res.status(429).json({
        error: "limit_reached",
        message: dailyLimit === FREE_DAILY_LIMIT
          ? `You've used all ${FREE_DAILY_LIMIT} free coach messages today. Upgrade to Pro for unlimited.`
          : `You've used all ${dailyLimit} Standard messages today. Upgrade to Pro for unlimited.`,
        used: dailyLimit,
        limit: dailyLimit,
      });
    }

    const tasks = await Task.find({ userId: req.userId, date: todayStr });
    const habits = await Habit.find({ userId: req.userId });
    const todayDone = tasks.filter(t => t.completed).length;
    const style = STYLE_PROMPTS[user.coachStyle] || STYLE_PROMPTS.spartan;
    const length = user.responseLength || "medium";
    const lengthGuide = LENGTH_GUIDANCE[length];
    const maxTokens = LENGTH_TOKENS[length];

    const memoryBlock = (isProTier && user.coachMemory)
      ? `\nPAST CONTEXT (from previous sessions):\n${user.coachMemory}\n`
      : "";
    const systemPrompt = `${style}${memoryBlock}

USER DATA:
- Username: ${user.username || "Warrior"}
- Streak: ${user.streak || 0} days
- Total XP: ${user.totalXP || 0}
- Today's tasks: ${tasks.length} total, ${todayDone} completed
- Active habits: ${habits.length}
- Plan: ${user.isPro ? "PRO" : "Free"}

RULES:
1. ${lengthGuide}
2. ALWAYS reference their specific numbers — never give generic advice
3. You can answer ANY question: discipline, fitness, coding, life, science, relationships
4. Stay in character for your coach style
5. Decline only illegal, violent, or harmful requests — politely`;

    const messages = [
      ...history.slice(-8).map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: message }
    ];

    // Pro users get the better model
    const model = user.isPro ? "gpt-4o" : "gpt-4o-mini";

    const completion = await getOpenAI().chat.completions.create({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      max_completion_tokens: maxTokens,
      temperature: 0.8,
    });

    const reply = completion.choices[0]?.message?.content || "Stay hard. Push through.";

    // Update rolling coach memory for Pro users (max 800 chars)
    if (isProTier && message.length > 10) {
      const memSnippet = `[${today()}] User asked: "${message.slice(0,100)}" Coach: "${reply.slice(0,150)}"`;
      const newMemory = ((user.coachMemory || "") + "
" + memSnippet).slice(-800);
      User.findByIdAndUpdate(req.userId, { coachMemory: newMemory }).catch(() => {});
    }

    res.json({
      reply,
      usage: { used: user.coachMessagesUsed, limit: isProTier ? null : dailyLimit },
    });
  } catch (err) {
    console.error("Coach error:", err);
    // Refund the reserved slot since the call failed
    try {
      await User.updateOne(
        { _id: req.userId, coachMessagesUsed: { $gt: 0 } },
        { $inc: { coachMessagesUsed: -1 } }
      );
    } catch (_) {}
    const code = err?.code;
    const status = err?.status;
    let errorKind = "unknown";
    if (code === "invalid_api_key" || status === 401) errorKind = "invalid_key";
    else if (code === "insufficient_quota") errorKind = "quota";
    else if (code === "rate_limit_exceeded" || status === 429) errorKind = "rate_limited";
    else if (status >= 500) errorKind = "openai_down";
    res.json({
      reply: "Training systems momentarily offline. The discipline is yours — push forward.",
      coachOffline: true,
      errorKind,
    });
  }
});

app.get("/api/coach/plan/today", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password");
    const tasks = await Task.find({ userId: req.userId, date: today() });
    res.json({
      plan: {
        greeting: `Stay hard, ${user?.username || "Warrior"}. No days off.`,
        dailyFocus: "Complete all tasks. Build the streak.",
        tasks: tasks.map(t => ({ id: t._id, title: t.title, difficulty: t.difficulty })),
      }
    });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.get("/api/coach/review/weekly", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password");
    res.json({
      review: {
        summary: "You're building something real.",
        strengths: ["Showing up", "Consistency"],
        improvements: ["Push harder on Hard tasks"],
        weeklyXP: user?.weeklyPoints || 0,
        streak: user?.streak || 0,
      }
    });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.get("/api/coach/habits/analysis", authMiddleware, async (req, res) => {
  try {
    const habits = await Habit.find({ userId: req.userId });
    const best = habits.sort((a, b) => b.streak - a.streak)[0];
    res.json({
      analysis: {
        overallScore: Math.min(100, habits.reduce((s, h) => s + h.streak, 0) * 2),
        insights: [],
        strongestHabit: best?.title || "None yet",
        needsWork: "Build more habits",
      }
    });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

// ── Support ───────────────────────────────────────────────────────────────────
app.post("/api/support/chat", authMiddleware, async (req, res) => {
  try {
    const { messages = [] } = req.body;
    const lastMsg = messages[messages.length - 1]?.content || "";

    const completion = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful support agent for the Don't Quit discipline app. Help with billing, account issues, and motivation. Be concise." },
        ...messages.slice(-5),
      ],
      max_tokens: 200,
    });

    const reply = completion.choices[0]?.message?.content || "Please email support@dontquitapp.com for help.";
    res.json({ reply });
  } catch (err) {
    res.json({ reply: "For account issues, email support@dontquitapp.com" });
  }
});

// ── Notifications ─────────────────────────────────────────────────────────────
app.get("/api/notifications", authMiddleware, async (req, res) => {
  try {
    const notifs = await Notification.find({ userId: req.userId }).sort({ date: -1 }).limit(50);
    res.json({ notifications: notifs });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.patch("/api/notifications/read", authMiddleware, async (req, res) => {
  try {
    const { ids } = req.body;
    if (ids?.length) await Notification.updateMany({ _id: { $in: ids }, userId: req.userId }, { read: true });
    else await Notification.updateMany({ userId: req.userId }, { read: true });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.patch("/api/notifications/settings", authMiddleware, async (req, res) => {
  res.json({ success: true });
});

app.post("/api/notifications/subscribe", authMiddleware, (req, res) => res.json({ success: true }));
app.delete("/api/notifications/subscribe", authMiddleware, (req, res) => res.json({ success: true }));

// ── Referrals ─────────────────────────────────────────────────────────────────
app.get("/api/referrals/code", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("referralCode");
    res.json({ code: user?.referralCode || "DONTQUIT" });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.get("/api/referrals/stats", authMiddleware, (req, res) => {
  res.json({ stats: { referrals: 0, earned: 0 }, code: "DONTQUIT" });
});

// ── Onboarding ────────────────────────────────────────────────────────────────
app.get("/api/onboarding/status", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("onboardingCompleted");
    res.json({ completed: user?.onboardingCompleted || false, status: user?.onboardingCompleted ? "done" : "pending" });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

// FIX #3: mark onboarding complete when step 5 is submitted
app.post("/api/onboarding/step", authMiddleware, async (req, res) => {
  try {
    const { step } = req.body;
    if (step === 5 || step === "5") {
      await User.findByIdAndUpdate(req.userId, { onboardingCompleted: true });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});
app.post("/api/onboarding/skip", authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, { onboardingCompleted: true });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

// ── Uploads ───────────────────────────────────────────────────────────────────
app.post("/api/uploads/avatar", authMiddleware, upload.single("file"), (req, res) => {
  res.json({ success: true, url: "" });
});

app.post("/api/uploads/task_proof", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    let url = "";
    // If Cloudinary is configured, upload there; otherwise return base64 data URL
    if (process.env.CLOUDINARY_URL || (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY)) {
      const { v2: cloudinary } = await import("cloudinary");
      const b64 = req.file.buffer.toString("base64");
      const dataUri = `data:${req.file.mimetype};base64,${b64}`;
      const result = await cloudinary.uploader.upload(dataUri, {
        folder: "dontquit/proofs",
        resource_type: "image",
        transformation: [{ width: 1200, crop: "limit", quality: "auto" }],
      });
      url = result.secure_url;
    } else {
      // Fallback: store as base64 data URL (fine for dev / Replit free tier)
      url = `data:${req.file.mimetype};base64,` + req.file.buffer.toString("base64");
    }
    // If taskId provided, update the task record
    if (req.body.taskId) {
      await Task.findOneAndUpdate({ _id: req.body.taskId, userId: req.userId }, { proofUrl: url });
    }
    res.json({ success: true, url });
  } catch (e) { console.error("Proof upload error:", e.message); res.status(500).json({ error: "Upload failed" }); }
});

app.post("/api/proof/verify", authMiddleware, (req, res) => {
  res.json({ valid: true, labels: ["activity", "effort"], message: "Verified.", confidence: 0.9 });
});

// ── Payments ──────────────────────────────────────────────────────────────────
app.get("/api/payment/status", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("isPro plan stripeSubscriptionId");
    res.json({ isPro: user?.isPro || false, plan: user?.plan || "free", trial: user?.plan === "trial" });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

// Resolve which Stripe price ID to use for a given (tier, interval) combination.
// Falls back to the legacy STRIPE_PRICE_ID env var for pro/monthly so the existing
// single-tier setup keeps working until the Standard prices are configured.
function resolveStripePrice(tier, interval) {
  const map = {
    "standard:month": process.env.STRIPE_PRICE_ID_STANDARD_MONTHLY,
    "standard:year":  process.env.STRIPE_PRICE_ID_STANDARD_YEARLY,
    "pro:month":      process.env.STRIPE_PRICE_ID_PRO_MONTHLY || process.env.STRIPE_PRICE_ID,
    "pro:year":       process.env.STRIPE_PRICE_ID_PRO_YEARLY,
  };
  return map[`${tier}:${interval}`] || null;
}

app.post("/api/payment/create-checkout", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const tier = ["standard","pro"].includes(req.body?.tier) ? req.body.tier : "pro";
    const interval = ["month","year"].includes(req.body?.interval) ? req.body.interval : "month";

    const priceId = resolveStripePrice(tier, interval);
    if (!priceId) {
      return res.status(400).json({
        error: "price_not_configured",
        message: `The ${tier} ${interval}ly plan isn't available yet. Please pick a different plan or contact support.`,
      });
    }

    // FIX #7: safe fallback so Stripe never gets "https://undefined"
    const frontendUrl =
      process.env.FRONTEND_URL ||
      (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null) ||
      `https://${req.headers.host}`;

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await getStripe().customers.create({ email: user.email, name: user.username });
      customerId = customer.id;
      await User.findByIdAndUpdate(req.userId, { stripeCustomerId: customerId });
    }

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${frontendUrl}?payment=success`,
      cancel_url: `${frontendUrl}?payment=cancel`,
      allow_promotion_codes: true,
      metadata: { tier, interval, userId: String(req.userId) },
      subscription_data: { metadata: { tier, interval, userId: String(req.userId) } },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/payment/portal", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user?.stripeCustomerId) return res.status(400).json({ error: "No billing account found" });
    // FIX #7: safe fallback so Stripe never gets "https://undefined"
    const frontendUrl =
      process.env.FRONTEND_URL ||
      (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null) ||
      `https://${req.headers.host}`;
    const session = await getStripe().billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: frontendUrl,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/payment/create-intent", authMiddleware, async (req, res) => {
  try {
    const intent = await getStripe().paymentIntents.create({ amount: 999, currency: "usd" });
    res.json({ clientSecret: intent.client_secret });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/payment/retry", authMiddleware, (req, res) => res.json({ success: true }));

// ── Stripe Webhook ────────────────────────────────────────────────────────────
app.post("/api/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log("Webhook signature error:", err.message);
    return res.sendStatus(400);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customerId = session.customer;
      const subTier = session.metadata?.tier || "pro"; // "standard" | "pro"
      const isProTier = subTier === "pro";
      console.log(`✅ Payment successful (${subTier}), customer:`, customerId);
      if (customerId) {
        await User.findOneAndUpdate(
          { stripeCustomerId: customerId },
          { isPro: isProTier, plan: subTier, tier: subTier, stripeSubscriptionId: session.subscription }
        );
      }
    }

    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      if (customerId) {
        await User.findOneAndUpdate({ stripeCustomerId: customerId }, { isPro: true, plan: "pro" });
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const customerId = sub.customer;
      if (customerId) {
        await User.findOneAndUpdate({ stripeCustomerId: customerId }, { isPro: false, plan: "free", tier: "free", stripeSubscriptionId: null });
      }
    }

    // Handles plan changes, payment failures, pauses, cancel-at-period-end, etc.
    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const customerId = sub.customer;
      // Active states keep Pro on; everything else (past_due, unpaid, incomplete_expired, canceled, paused) drops to free.
      const activeStatuses = new Set(["active", "trialing"]);
      const isActive = activeStatuses.has(sub.status);
      if (customerId) {
        await User.findOneAndUpdate(
          { stripeCustomerId: customerId },
          isActive
            ? { isPro: true, plan: "pro", stripeSubscriptionId: sub.id }
            : { isPro: false, plan: "free" }
        );
        console.log(`🔄 Subscription ${sub.id} now ${sub.status} → isPro=${isActive}`);
      }
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      // Don't immediately revoke — Stripe retries. Just log; revocation flows through subscription.updated/deleted.
      console.log(`⚠️ Invoice payment failed for customer ${customerId}`);
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }

  res.sendStatus(200);
});

// ── Fallback ──────────────────────────────────────────────────────────────────

// ── Streak Insurance — POST /api/streak/freeze ────────────────────────────────
// Pro users get 1 freeze per week. If they missed yesterday, consuming a freeze
// saves their streak by pretending they completed yesterday.
app.post("/api/streak/freeze", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.isPro && user.tier !== "pro") return res.status(403).json({ error: "Streak insurance is a Pro feature" });

    // Compute ISO week string e.g. "2025-W23"
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((now - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
    const isoWeek = `${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;

    // Reset freeze if new week
    if (user.streakFreezeWeek !== isoWeek) {
      user.streakFreezeCount = 1;
      user.streakFreezeUsed = false;
      user.streakFreezeWeek = isoWeek;
    }

    if (user.streakFreezeUsed || user.streakFreezeCount < 1) {
      return res.status(429).json({ error: "No freeze available this week" });
    }

    // Check they actually missed yesterday
    const yest = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    if (user.lastCompletedDate === yest || user.lastCompletedDate === today()) {
      return res.status(400).json({ error: "Your streak is intact — no freeze needed" });
    }

    // Apply freeze: preserve streak, mark yesterday as covered
    user.streakFreezeUsed = true;
    user.streakFreezeCount -= 1;
    user.lastCompletedDate = yest; // treat yesterday as completed
    await user.save();

    res.json({ success: true, streak: user.streak, message: "Streak saved! Freeze used for this week." });
  } catch (e) { console.error("Streak freeze error:", e); res.status(500).json({ error: "Failed" }); }
});

app.get("/api/streak/status", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("streak streakFreezeCount streakFreezeUsed streakFreezeWeek isPro tier lastCompletedDate");
    const yest = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const atRisk = user.lastCompletedDate && user.lastCompletedDate < yest;
    res.json({
      streak: user.streak,
      atRisk,
      freezeAvailable: (user.isPro || user.tier === "pro") && !user.streakFreezeUsed && user.streakFreezeCount > 0,
    });
  } catch (e) { res.status(500).json({ error: "Failed" }); }
});


// ── GET /api/tasks/heatmap — last 365 days of task completion data ────────────
app.get("/api/tasks/heatmap", authMiddleware, async (req, res) => {
  try {
    const since = new Date();
    since.setFullYear(since.getFullYear() - 1);
    const sinceStr = since.toISOString().split("T")[0];
    const tasks = await Task.find({
      userId: req.userId,
      date:   { $gte: sinceStr },
    }).select("date completed difficulty").lean();

    // Group by date: { "2025-01-15": { total: 3, done: 2, xp: 35 } }
    const byDate = {};
    for (const t of tasks) {
      if (!byDate[t.date]) byDate[t.date] = { total: 0, done: 0, xp: 0 };
      byDate[t.date].total++;
      if (t.completed) {
        byDate[t.date].done++;
        byDate[t.date].xp += ({ Hard: 50, Medium: 25, Easy: 10 }[t.difficulty] || 0);
      }
    }
    res.json({ heatmap: byDate });
  } catch (e) { res.status(500).json({ error: "Failed" }); }
});


// ── GET /api/coach/review/weekly-ai — AI-generated weekly summary ─────────────
app.get("/api/coach/review/weekly-ai", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password");
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const tasks = await Task.find({ userId: req.userId, date: { $gte: sevenDaysAgo } });
    const habits = await Habit.find({ userId: req.userId });

    const done = tasks.filter(t => t.completed);
    const hard = done.filter(t => t.difficulty === "Hard");
    const totalXP = done.reduce((s, t) => s + (t.xpEarned || 0), 0);
    const habitsDone = habits.filter(h => h.streak > 0).length;

    // Group tasks by day for "hardest day" calculation
    const byDay = {};
    for (const t of tasks) { byDay[t.date] = (byDay[t.date] || 0) + (t.completed ? 1 : 0); }
    const hardestDay = Object.entries(byDay).sort((a,b) => b[1]-a[1])[0]?.[0] || null;
    const hardestDayName = hardestDay ? new Date(hardestDay + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long" }) : "N/A";

    const prompt = `Generate a personal weekly review for ${user.username}.
Stats: ${done.length} tasks completed (${hard.length} Hard), ${habitsDone}/${habits.length} habits maintained, ${totalXP} XP earned, ${user.streak} day streak. Hardest day: ${hardestDayName}.
Write 3-4 sentences: acknowledge what they did, note one strength, suggest one focus for next week. Be ${user.coachStyle || "spartan"} in tone. No bullet points.`;

    const completion = await getOpenAI().chat.completions.create({
      model: user.isPro ? "gpt-4o" : "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 200,
      temperature: 0.7,
    });

    res.json({
      review: completion.choices[0]?.message?.content || "Keep going. Another week, another chance to build.",
      stats: { tasksCompleted: done.length, hardTasksCompleted: hard.length, xpEarned: totalXP, habitsKept: habitsDone, totalHabits: habits.length, streak: user.streak, hardestDay: hardestDayName },
    });
  } catch (e) { console.error("Weekly review error:", e); res.status(500).json({ error: "Failed" }); }
});


// ── GET /api/user/export — download all user data as JSON ─────────────────────
app.get("/api/user/export", authMiddleware, async (req, res) => {
  try {
    const [user, tasks, habits] = await Promise.all([
      User.findById(req.userId).select("-password -resetToken -resetTokenExpiry -pushSubscription").lean(),
      Task.find({ userId: req.userId }).lean(),
      Habit.find({ userId: req.userId }).lean(),
    ]);
    const exportData = { exportedAt: new Date().toISOString(), user, tasks, habits };
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=dontquit-export.json");
    res.json(exportData);
  } catch (e) { res.status(500).json({ error: "Export failed" }); }
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

const PORT = process.env.BACKEND_PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
