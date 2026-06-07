import { createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  PageBreak,
  Paragraph,
  TextRun,
} from "docx";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testsDir = path.resolve(__dirname, "../tests");

const docxPath = path.join(testsDir, "qa-test-english.docx");
const pipelinePdfPath = path.join(testsDir, "qa-pipeline-test.pdf");
const oversizedPdfPath = path.join(testsDir, "qa-test-oversized.pdf");
const corruptPdfPath = path.join(testsDir, "qa-test-corrupt.pdf");

const biologySections = [
  {
    heading: "The Cell",
    paragraphs: [
      "Cells are the fundamental units of human biology because every tissue, organ, and physiological system depends on their organized activity. A human cell is enclosed by a selectively permeable plasma membrane that regulates the movement of water, ions, nutrients, and signaling molecules. Inside the cell, cytoplasm contains a dynamic network of proteins, membranes, and organelles that allow chemical reactions to occur in carefully controlled spaces. The nucleus stores genetic information in chromosomes and coordinates the expression of genes that determine how a cell grows, repairs itself, and responds to its environment. Mitochondria convert chemical energy from food into adenosine triphosphate, while ribosomes and the endoplasmic reticulum help synthesize proteins needed for structure, enzymes, transport, and communication.",
      "Specialization is one of the most important principles in cell biology. Although most human cells share the same genome, they use different sets of genes depending on their role. Muscle cells contain contractile proteins that make movement possible, epithelial cells form protective and absorptive barriers, and immune cells identify pathogens or damaged tissue. Cell communication depends on receptors, hormones, neurotransmitters, and local chemical signals that allow tissues to coordinate activity. When these signals are disrupted, normal regulation can give way to disease, including uncontrolled division in cancer, impaired insulin response in diabetes, or inflammatory injury in autoimmune disorders.",
      "Cellular homeostasis also depends on controlled transport and waste management. Lysosomes break down worn components, peroxisomes help neutralize harmful chemicals, and membrane pumps maintain ion gradients that support nerve impulses and muscle contraction. The cell cycle includes checkpoints that verify DNA integrity before division, and programmed cell death removes cells that are damaged beyond repair. These processes illustrate that the cell is not a simple container of biological material but an active, regulated system that preserves life through thousands of coordinated molecular events every second.",
    ],
    bullets: [
      "The plasma membrane controls exchange between the cell and its surroundings.",
      "The nucleus stores genetic instructions and regulates gene expression.",
      "Mitochondria supply usable energy through cellular respiration.",
      "Cell specialization allows tissues to perform distinct biological functions.",
    ],
  },
  {
    heading: "The Nervous System",
    paragraphs: [
      "The nervous system is the body's major communication network, integrating sensory information, coordinating movement, and supporting cognition, emotion, and memory. It is divided into the central nervous system, which includes the brain and spinal cord, and the peripheral nervous system, which includes nerves that connect the central system to the rest of the body. Neurons transmit information through electrical impulses called action potentials, and they communicate with other cells at synapses using chemical messengers known as neurotransmitters. This combination of electrical speed and chemical specificity allows the nervous system to respond rapidly while preserving precise control over muscles, glands, and internal organs.",
      "The brain contains specialized regions that work together rather than acting in isolation. The cerebral cortex supports perception, reasoning, language, and voluntary movement. The cerebellum refines balance and coordination, while the brainstem regulates essential functions such as breathing, heart rate, and arousal. The spinal cord serves as both a pathway for messages traveling between the brain and body and a center for reflexes that protect the body before conscious awareness occurs. Glial cells, once viewed mainly as support cells, are now known to help regulate synaptic activity, form myelin, maintain the chemical environment around neurons, and participate in immune defense within nervous tissue.",
      "Healthy nervous system function depends on plasticity, the ability of neural circuits to change with experience. Learning strengthens some synaptic connections and weakens others, while injury can sometimes lead surviving circuits to reorganize. However, neurons are vulnerable to oxygen deprivation, trauma, toxins, infection, and degenerative disease. Conditions such as stroke, multiple sclerosis, Parkinson disease, and Alzheimer's disease show how disruptions in neural signaling can affect movement, sensation, memory, and identity. Understanding the nervous system therefore requires attention to both its rapid signaling mechanisms and its long-term capacity for adaptation.",
    ],
    bullets: [
      "Sensory neurons carry information from receptors toward the central nervous system.",
      "Motor neurons transmit commands from the central nervous system to muscles.",
      "Interneurons process information within the brain and spinal cord.",
      "Glial cells support, protect, and regulate neurons.",
    ],
  },
  {
    heading: "The Circulatory System",
    paragraphs: [
      "The circulatory system transports oxygen, nutrients, hormones, immune cells, heat, and waste products throughout the body. Its central pump is the heart, a muscular organ with four chambers that maintains separate pulmonary and systemic circuits. The right side of the heart sends deoxygenated blood to the lungs, where carbon dioxide is released and oxygen is absorbed. The left side pumps oxygen-rich blood into the aorta and through branching arteries that reach tissues across the body. Valves keep blood moving in one direction, and the rhythmic contraction of cardiac muscle is coordinated by electrical signals that begin in the sinoatrial node.",
      "Blood vessels are specialized for different pressures and functions. Arteries have thick, elastic walls that tolerate high pressure and help smooth the pulsing flow generated by the heart. Arterioles regulate local blood distribution by changing diameter, while capillaries provide thin exchange surfaces where gases, nutrients, and waste products move between blood and tissues. Veins return blood to the heart at lower pressure and often contain valves that prevent backflow, especially in the limbs. Blood itself contains plasma, red blood cells that carry oxygen using hemoglobin, white blood cells that participate in immune defense, and platelets that support clotting after injury.",
      "Circulatory health is closely linked to lifestyle, genetics, and other body systems. Blood pressure must be high enough to perfuse organs but not so high that it damages vessels. The kidneys regulate fluid volume and electrolytes, endocrine signals influence vessel tone and heart rate, and the autonomic nervous system adjusts circulation during exercise, rest, stress, and temperature change. Atherosclerosis, anemia, arrhythmias, hypertension, and heart failure demonstrate that circulation depends on coordinated structure and regulation. Because every living cell depends on exchange with the blood, circulatory failure quickly affects the brain, kidneys, muscles, and other vital tissues.",
    ],
    bullets: [
      "The pulmonary circuit carries blood between the heart and lungs.",
      "The systemic circuit supplies oxygenated blood to body tissues.",
      "Capillaries are the main sites of material exchange.",
      "Blood pressure reflects cardiac output and resistance in the vessels.",
    ],
  },
];

const oversizedParagraphs = [
  "Human physiology examines how cells, tissues, and organs maintain internal stability while responding to changing conditions. Each system contributes to homeostasis through feedback loops that detect variation, compare it with a useful range, and activate responses that restore balance. These principles apply to temperature regulation, fluid balance, glucose control, oxygen delivery, and many other processes essential for life.",
  "Academic study of biology also depends on evidence, measurement, and clear explanation. A concept becomes useful when it can connect molecular mechanisms to observable outcomes in the whole organism. For example, the movement of ions across membranes can explain nerve impulses, muscle contraction, and the regulation of heartbeat. Repeated observations across levels of organization help students build durable scientific understanding.",
];

const photosynthesisParagraphs = [
  "Photosynthesis is the process plants use to convert light energy into chemical energy. In green leaves, chlorophyll captures sunlight and helps power reactions that turn carbon dioxide and water into glucose.",
  "The light-dependent reactions happen in the thylakoid membranes of chloroplasts. These reactions split water molecules, release oxygen, and store energy in molecules that can support the next stage.",
  "The Calvin cycle uses stored chemical energy to build sugars from carbon dioxide. The sugars can be used for growth, stored as starch, or moved through the plant to support cells that do not photosynthesize.",
];

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function createTextParagraph(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 24 })],
    spacing: { after: 180 },
  });
}

async function generateDocx() {
  const bodyText = biologySections
    .flatMap((section) => [section.heading, ...section.paragraphs, ...section.bullets])
    .join(" ");
  const wordCount = countWords(bodyText);

  if (wordCount < 800) {
    throw new Error(`DOCX content must contain at least 800 words; found ${wordCount}`);
  }

  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { before: 2400, after: 360 },
      children: [new TextRun("Human Biology: An Introduction")],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "A concise academic overview for QA extraction and generation testing.",
          italics: true,
          size: 24,
        }),
      ],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];

  for (const [index, section] of biologySections.entries()) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun(section.heading)],
      spacing: { before: 160, after: 160 },
    }));

    for (const paragraph of section.paragraphs) {
      children.push(createTextParagraph(paragraph));
    }

    for (const bullet of section.bullets) {
      children.push(new Paragraph({
        text: bullet,
        bullet: { level: 0 },
        spacing: { after: 80 },
      }));
    }

    if (index === 1) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: 720,
            right: 720,
            bottom: 720,
            left: 720,
          },
        },
      },
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  await fs.writeFile(docxPath, buffer);
  console.log(`Generated ${path.relative(process.cwd(), docxPath)} (${wordCount} words)`);
}

async function generatePipelinePdf() {
  await new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "LETTER",
      margins: { top: 72, right: 72, bottom: 72, left: 72 },
    });
    const stream = createWriteStream(pipelinePdfPath);
    pdf.pipe(stream);

    pdf.fontSize(18).text("Photosynthesis Overview", { align: "center" });
    pdf.moveDown(1.5);

    for (const paragraph of photosynthesisParagraphs) {
      pdf.fontSize(12).text(paragraph, {
        align: "left",
        lineGap: 5,
      });
      pdf.moveDown(0.8);
    }

    pdf.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
    pdf.on("error", reject);
  });

  console.log(`Generated ${path.relative(process.cwd(), pipelinePdfPath)} (1 page)`);
}

async function generateOversizedPdf() {
  await new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "LETTER",
      margins: { top: 56, right: 56, bottom: 56, left: 56 },
      autoFirstPage: false,
    });
    const stream = createWriteStream(oversizedPdfPath);
    pdf.pipe(stream);

    for (let page = 1; page <= 202; page += 1) {
      pdf.addPage();
      pdf.fontSize(18).text(`Human Biology Review - Page ${page}`, { align: "center" });
      pdf.moveDown(1);
      pdf.fontSize(11).text(oversizedParagraphs[0], {
        align: "left",
        lineGap: 4,
      });
      pdf.moveDown(0.8);
      pdf.text(oversizedParagraphs[1], {
        align: "left",
        lineGap: 4,
      });
      pdf.moveDown(1);
      pdf.fontSize(9).fillColor("#555555").text(
        "This repeated academic page is intentionally included so the QA runner can verify the 200-page upload limit.",
      );
      pdf.fillColor("#000000");
    }

    pdf.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
    pdf.on("error", reject);
  });

  console.log(`Generated ${path.relative(process.cwd(), oversizedPdfPath)} (202 pages)`);
}

async function generateCorruptPdf() {
  const bytes = Buffer.from([
    0x51, 0x41, 0x2d, 0x43, 0x4f, 0x52, 0x52, 0x55,
    0x50, 0x54, 0x2d, 0x50, 0x44, 0x46, 0x00, 0xff,
    0x13, 0x37, 0x99, 0x42, 0x10, 0x00, 0xab, 0xcd,
    0x65, 0x78, 0x74, 0x72, 0x61, 0x63, 0x74, 0x2d,
    0x66, 0x61, 0x69, 0x6c, 0x75, 0x72, 0x65,
  ]);
  await fs.writeFile(corruptPdfPath, bytes);
  console.log(`Generated ${path.relative(process.cwd(), corruptPdfPath)} (invalid PDF bytes)`);
}

await fs.mkdir(testsDir, { recursive: true });
await generateDocx();
await generatePipelinePdf();
await generateOversizedPdf();
await generateCorruptPdf();
