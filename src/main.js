import recordCanvas from "./record.js";

const canvas = document.getElementsByTagName("canvas")[0];
const ctx = canvas.getContext("2d");
ctx.font = "24px monospace";
ctx.textAlign = "center";
ctx.textBaseline = "middle";

const N = 5 * 60;
let t = 0;
function draw() {
  const x = 20 * Math.cos((2 * Math.PI * t) / N);
  const y = 20 * Math.sin((2 * Math.PI * t) / N);
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "black";
  ctx.fillRect(canvas.width / 2 + x - 5, canvas.height / 2 + y - 5, 10, 10);
  t++;

  let s = (t < 10 ? "0" : "") + t.toString();
  ctx.fillText(s, canvas.width / 2, canvas.height / 2);

  // simulate slow rendering
  // for (let x = 0; x < 100000000; x++) {
  //   void Math.pow(x, t);
  // }

  return t >= N;
}

recordCanvas(canvas, draw, {
  mediaType: "video/webm",
  // mediaType: "video/webm;codecs=h264", // chrome only
  fps: 60
})
  .then(blob => {
    const container = document.getElementById("links");

    const url = URL.createObjectURL(blob);
    const a = container.appendChild(document.createElement("a"));
    a.textContent = "Download";
    a.href = url;
    a.download = "out.webm";

    container.appendChild(document.createElement("br"));

    const b = container.appendChild(document.createElement("a"));
    b.textContent = "Preview";
    b.href = url;
    b.target = "_blank";
  })
  .catch(e => {
    console.error(e);
    alert(e);
  });
