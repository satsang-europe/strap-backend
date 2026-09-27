/**
 * app-notification router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::app-notification.app-notification', {
  except: ['find', 'findOne', 'create', 'update', 'delete'],
});
