import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputPath = path.resolve(__dirname, "../tests/qa-test-document.pdf");

const paragraph = [
  "Photosynthesis is the biochemical process by which green plants, algae, and some bacteria convert light energy into stored chemical energy.",
  "In chloroplasts, chlorophyll absorbs sunlight and drives reactions that use carbon dioxide and water to produce glucose and oxygen.",
  "The light-dependent reactions generate ATP and NADPH, while the Calvin cycle fixes carbon into carbohydrates.",
  "This process supports plant growth, regulates atmospheric oxygen, and forms the energetic foundation of many ecosystems.",
].join(" ");

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const document = new PDFDocument({
  size: "LETTER",
  margins: {
    top: 72,
    right: 72,
    bottom: 72,
    left: 72,
  },
});

const stream = fs.createWriteStream(outputPath);
document.pipe(stream);

document
  .font("Times-Bold")
  .fontSize(16)
  .text("Photosynthesis Overview", { align: "left" });

document.moveDown();

document
  .font("Times-Roman")
  .fontSize(12)
  .text(paragraph, {
    align: "left",
    lineGap: 4,
  });

document.end();

stream.on("finish", () => {
  console.log(`Generated ${outputPath}`);
});
