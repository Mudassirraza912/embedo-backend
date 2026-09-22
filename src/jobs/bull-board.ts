import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { aiPipelineQueue } from './ai-pipeline.queue.js';
import { exportQueue } from './export.queue.js';
import { componentRefreshQueue } from './component-refresh.queue.js';
import { datasheetIngestQueue } from './datasheet-ingest.queue.js';

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [
    new BullMQAdapter(aiPipelineQueue),
    new BullMQAdapter(exportQueue),
    new BullMQAdapter(componentRefreshQueue),
    new BullMQAdapter(datasheetIngestQueue),
  ],
  serverAdapter,
});

export const bullBoardRouter = serverAdapter.getRouter();
