import { Router, type IRouter } from "express";
import healthRouter from "./health";
import coachRouter from "./coach";
import recipeImageRouter from "./recipe-image";

const router: IRouter = Router();

router.use(healthRouter);
router.use(coachRouter);
router.use(recipeImageRouter);

export default router;
