export default {
  routes: [
    {
      method: 'GET',
      path: '/mobile-notifications',
      handler: 'app-notification.findActive',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/mobile-notifications/:documentId',
      handler: 'app-notification.findActiveOne',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
