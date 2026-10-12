/**
 * 语言模型连接配置（OpenAI 兼容接口）。
 */
export interface LlmSettings {
  /** 接口根地址，如 https://api.example.com/v1 */
  baseURL: string;
  /** API 密钥（以 Bearer Token 形式随请求发送；留空则不携带鉴权头） */
  apiKey: string;
  /** 模型名，如 gpt-4o-mini */
  model: string;
}
