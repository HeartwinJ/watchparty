export default {
  // Where the API/socket server is, e.g. https://watch.example.com. Leave unset to use hostname:8080 in dev and
  // the same origin in production.
  VITE_SERVER_HOST: import.meta.env.VITE_SERVER_HOST,
  NODE_ENV: import.meta.env.DEV ? "development" : "production",
};
