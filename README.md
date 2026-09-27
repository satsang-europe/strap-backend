# 🚀 Getting started with Strapi

## Mobile push delivery

Publishing an `App Notification` creates one private `Push Delivery` record. The
delivery key combines the notification document ID and activation time, which
prevents the same publication from being queued twice.
Republishing a future notification updates its still-pending title and message
without creating another delivery.

The worker runs after publication, at server startup, and once per minute. It:

- sends to enabled anonymous subscriptions in Expo batches of at most 100;
- includes `notificationDocumentId` so a tap opens the matching app detail;
- stores Expo ticket IDs for later receipt checks;
- disables subscriptions rejected immediately as `DeviceNotRegistered`;
- retries temporary request failures up to five times with increasing delays;
- resumes stale work after a restart and never sends after the 72-hour window;
- preserves progress between batches so a retry does not resend completed batches.

`EXPO_ACCESS_TOKEN` is optional. Set it in the hosting environment only if Expo
Push Service access-token security is enabled for the EAS project. Never commit
the token.

Future-dated notifications are queued at publication and become eligible at
`scheduledFor`. The in-process worker can only run while the Render web service
is awake. Exact unattended scheduling on a sleeping free instance will require
an external authenticated wake-up/worker mechanism in a later increment.

Expo ticket submission is implemented. Receipt polling and receipt-level invalid
token cleanup are the next backend increment.

Strapi comes with a full featured [Command Line Interface](https://docs.strapi.io/dev-docs/cli) (CLI) which lets you scaffold and manage your project in seconds.

### `develop`

Start your Strapi application with autoReload enabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-develop)

```
npm run develop
# or
yarn develop
```

### `start`

Start your Strapi application with autoReload disabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-start)

```
npm run start
# or
yarn start
```

### `build`

Build your admin panel. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-build)

```
npm run build
# or
yarn build
```

## ⚙️ Deployment

Strapi gives you many possible deployment options for your project including [Strapi Cloud](https://cloud.strapi.io). Browse the [deployment section of the documentation](https://docs.strapi.io/dev-docs/deployment) to find the best solution for your use case.

```
yarn strapi deploy
```

## 📚 Learn more

- [Resource center](https://strapi.io/resource-center) - Strapi resource center.
- [Strapi documentation](https://docs.strapi.io) - Official Strapi documentation.
- [Strapi tutorials](https://strapi.io/tutorials) - List of tutorials made by the core team and the community.
- [Strapi blog](https://strapi.io/blog) - Official Strapi blog containing articles made by the Strapi team and the community.
- [Changelog](https://strapi.io/changelog) - Find out about the Strapi product updates, new features and general improvements.

Feel free to check out the [Strapi GitHub repository](https://github.com/strapi/strapi). Your feedback and contributions are welcome!

## ✨ Community

- [Discord](https://discord.strapi.io) - Come chat with the Strapi community including the core team.
- [Forum](https://forum.strapi.io/) - Place to discuss, ask questions and find answers, show your Strapi project and get feedback or just talk with other Community members.
- [Awesome Strapi](https://github.com/strapi/awesome-strapi) - A curated list of awesome things related to Strapi.

---

<sub>🤫 Psst! [Strapi is hiring](https://strapi.io/careers).</sub>
