import { Router, type IRouter } from "express";
import healthRouter from "./health";
import publicRouter from "./public";
import accountRouter from "./account";
import applicationsRouter from "./applications";
import lessonsRouter from "./lessons";
import dashboardsRouter from "./dashboards";

const router: IRouter = Router();

router.use(healthRouter);
router.use(publicRouter);
router.use(accountRouter);
router.use(applicationsRouter);
router.use(lessonsRouter);
router.use(dashboardsRouter);

export default router;
