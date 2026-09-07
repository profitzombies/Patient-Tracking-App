module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...(config.extra || {}),
    eas: {
      ...((config.extra && config.extra.eas) || {}),
      ...(process.env.EAS_PROJECT_ID ? { projectId: process.env.EAS_PROJECT_ID } : {}),
    },
  },
});