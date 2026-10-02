/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 注意：此設定只對 webpack 生效，dev / build 請勿加 --turbopack。
  webpack: (config, { isServer }) => {
    // @xenova/transformers v2 只在瀏覽器使用；server 與 client 兩個 compile 都要擋掉 node 專用原生模組
    config.resolve.alias = { ...config.resolve.alias, sharp$: false, "onnxruntime-node$": false };
    if (!isServer) config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false };
    return config;
  },
};

export default nextConfig;
