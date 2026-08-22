import { Router, type IRouter } from "express";
import healthRouter from "./health";
import coachRouter from "./coach";

const router: IRouter = Router();

router.use(healthRouter);
router.use(coachRouter);

export default router;
