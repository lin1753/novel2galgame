import fetch from "node-fetch";
async function test() {
  const url = "http://localhost:3000/projects/project_f3cc676426c0/rag/characters";
  try {
    const res = await fetch(url);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(err);
  }
}
test();
