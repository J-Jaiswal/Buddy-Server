import { Router } from "express";
import { serviceStatus } from "../services/serviceStatus.js";

const router = Router();

router.get("/health", (req, res) => {
  const allOk = Object.values(serviceStatus).every((s) => s.ok);
  res.status(allOk ? 200 : 207).json({
    status: allOk ? "ok" : "degraded",
    services: serviceStatus,
    timestamp: new Date().toISOString(),
  });
});

export default router;
