export default {
  routes: [
    {
      method: 'POST',
      path: '/mobile-push-subscriptions/register',
      handler: 'push-subscription.register',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/mobile-push-subscriptions/unregister',
      handler: 'push-subscription.unregister',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
