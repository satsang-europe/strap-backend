export default {
  check(ctx) {
    ctx.body = {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  },
};
