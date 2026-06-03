// routes/chat.js
import { Router } from "express";
import { validateChatRequest } from "../middleware/validate.js";
import { handleChat, handleHistory } from "../controllers/chatController.js";

const router = Router();

router.post("/chat", validateChatRequest, handleChat);
router.get("/history", handleHistory);

export default router;
