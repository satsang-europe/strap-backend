import type { Core } from '@strapi/strapi';

import {
  processPendingPushDeliveries,
  registerNotificationPublishHook,
} from './services/push-delivery';

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register({ strapi }: { strapi: Core.Strapi }) {
    registerNotificationPublishHook(strapi);
  },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  bootstrap({ strapi }: { strapi: Core.Strapi }) {
    strapi.cron.add({
      pushDeliveryWorker: {
        options: { rule: '*/1 * * * *' },
        task: async ({ strapi: cronStrapi }) => {
          await processPendingPushDeliveries(cronStrapi);
        },
      },
    });

    queueMicrotask(() => {
      void processPendingPushDeliveries(strapi).catch((error) => {
        strapi.log.error(`[push-delivery] Startup worker failed: ${String(error)}`);
      });
    });
  },
};
