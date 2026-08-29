import https from "https";

const req = https.request(
  "https://apihub.agnes-ai.cn/v1/chat/completions",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + (process.env.OPENAI_API_KEY || "YOUR_KEY_HERE"),
    }
  },
  (res) => {
    let body = "";
    res.on("data", chunk => body += chunk);
    res.on("end", () => {
      console.log("Status:", res.statusCode);
      console.log("Body length:", body.length);
      console.log("Body:", body.substring(0, 1500) + "...");
    });
  }
);

req.write(JSON.stringify({
  model: "agnes-2.0-flash",
  messages: [{ role: "user", content: "Tell me a joke" }],
  max_tokens: 10
}));

req.end();
