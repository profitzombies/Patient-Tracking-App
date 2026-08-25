import { Router, type IRouter } from "express";
import healthRouter from "./health";
import coachRouter from "./coach";
import recipeImageRouter from "./recipe-image";
import menuScanRouter from "./menu-scan";
import trainingMediaRouter from "./training-media";
import staffLoginsRouter from "./staff-logins";

const router: IRouter = Router();

router.use(healthRouter);
router.use(coachRouter);
router.use(recipeImageRouter);
router.use(menuScanRouter);
router.use(trainingMediaRouter);
router.use(staffLoginsRouter);

export default router;
