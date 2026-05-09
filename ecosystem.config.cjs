module.exports = {
  apps: [
    {
      name: "stock-tracker",
      script: "npm",
      args: "run start",
      cwd: __dirname,
      env: {
        NODE_ENV: "production"
      },
      watch: false,
      autorestart: true,
      max_restarts: 10
    }
  ]
};
