import { Router, type IRouter } from "express";
import healthRouter from "./health";
import coachRouter from "./coach";
import recipeImageRouter from "./recipe-image";
import menuScanRouter from "./menu-scan";
import trainingMediaRouter from "./training-media";
import knowledgeDocsRouter from "./knowledge-docs";
import staffLoginsRouter from "./staff-logins";
import labelScanRouter from "./label-scan";
import supportRouter from "./support";

const router: IRouter = Router();

router.use(healthRouter);
router.use(coachRouter);
router.use(supportRouter);
router.use(recipeImageRouter);
router.use(menuScanRouter);
router.use(labelScanRouter);
router.use(trainingMediaRouter);
router.use(knowledgeDocsRouter);
router.use(staffLoginsRouter);

export default router;
