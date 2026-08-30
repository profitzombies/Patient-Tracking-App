import { Router, type IRouter } from "express";
import healthRouter from "./health";
import coachRouter from "./coach";
import recipeImageRouter from "./recipe-image";
import menuScanRouter from "./menu-scan";
import trainingMediaRouter from "./training-media";
import progressPhotosRouter from "./progress-photos";
import knowledgeDocsRouter from "./knowledge-docs";
import staffLoginsRouter from "./staff-logins";
import labelScanRouter from "./label-scan";
import barcodeRouter from "./barcode";
import supportRouter from "./support";
import claimRouter from "./claim";
import authRouter from "./auth";
import providerAccountsRouter from "./provider-accounts";
import hqTeamRouter from "./hq-team";

const router: IRouter = Router();

router.use(healthRouter);
router.use(coachRouter);
router.use(supportRouter);
router.use(recipeImageRouter);
router.use(menuScanRouter);
router.use(labelScanRouter);
router.use(barcodeRouter);
router.use(trainingMediaRouter);
router.use(progressPhotosRouter);
router.use(knowledgeDocsRouter);
router.use(staffLoginsRouter);
router.use(claimRouter);
router.use(authRouter);
router.use(providerAccountsRouter);
router.use(hqTeamRouter);

export default router;
