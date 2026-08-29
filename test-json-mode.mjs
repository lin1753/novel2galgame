import https from "https";

function test(jsonMode) {
  return new Promise((resolve) => {
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
          console.log(`jsonMode: ${jsonMode}`);
          console.log("Status:", res.statusCode);
          console.log("Body length:", body.length);
          const data = JSON.parse(body);
          console.log("Reasoning length:", data.choices[0].message.reasoning_content?.length);
          console.log("Content length:", data.choices[0].message.content?.length);
          console.log("Finish reason:", data.choices[0].finish_reason);
          resolve();
        });
      }
    );

    const payload = {
      model: "agnes-2.0-flash",
      messages: [
        { role: "system", content: "Extract data to JSON. Output JSON only." },
        { role: "user", content: "Names: Alice, Bob, Charlie." }
      ],
      max_tokens: 150
    };
    if (jsonMode) {
      payload.response_format = { type: "json_object" };
    }

    req.write(JSON.stringify(payload));
    req.end();
  });
}

async function run() {
  await test(false);
  await test(true);
}
run();
