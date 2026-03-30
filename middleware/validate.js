/**
 * Validate /chat request body.
 * Required: message, userId, characterId
 */
export function validateChatRequest(req, res, next) {
  const { message, userId, characterId } = req.body;
  if (!message) return res.status(400).json({ error: "message is required" });
  if (!userId) return res.status(400).json({ error: "userId is required" });
  if (!characterId)
    return res.status(400).json({ error: "characterId is required" });
  next();
}
