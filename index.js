const express = require("express");
const admin = require("firebase-admin");
const cron = require("cron");
const fetch = require("node-fetch");
const cors = require("cors");
const multer = require("multer");
require("dotenv").config();

const { supabase } = require('./supabaseClient');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
console.log("Firebase initialized successfully");

const db = admin.firestore();
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const corsOptions = {
  origin: ['https://ehms-sail.web.app', 'http://localhost:3000', 'http://localhost:3001'],
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

// Set up multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload-report", upload.single('file'), async (req, res) => {
  const { file } = req;
  const { patientId, fileName } = req.body;

  if (!file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const filePath = `${patientId}/${fileName}`;
    const { data, error } = await supabase.storage.from('reports').upload(filePath, file.buffer);

    if (error) {
      throw error;
    }

    res.status(200).json({ path: data.path });
  } catch (error) {
    console.error("Error uploading file:", error);
    res.status(500).json({ error: "Failed to upload file" });
  }
});

app.get("/appointments", async (req, res) => {
  try {
    const appointmentsRef = db.collection("Appointments");
    const snapshot = await appointmentsRef.get();
    const appointments = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(appointments);
  } catch (error) {
    console.error("Error fetching appointments:", error);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});

app.post("/api/verify-recaptcha", async (req, res) => {
  const { token } = req.body;

  const secretKey = process.env.RECAPTCHA_SECRET_KEY;

  const response = await fetch(`https://www.google.com/recaptcha/api/siteverify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `secret=${secretKey}&response=${token}`,
  });

  const data = await response.json();

  if (data.success) {
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.get("/get-reports", async (req, res) => {
  const { patientId } = req.query;

  try {
    const { data, error } = await supabase.storage.from('reports').list(patientId);

    if (error) {
      throw error;
    }

    const reports = await Promise.all(
      data.map(async (file) => {
        const { signedURL } = await supabase.storage.from('reports').createSignedUrl(`${patientId}/${file.name}`, 60);
        return { name: file.name, url: signedURL };
      })
    );

    res.status(200).json({ reports });
  } catch (error) {
    console.error("Error retrieving reports:", error);
    res.status(500).json({ error: "Failed to retrieve reports" });
  }
});

const job = new cron.CronJob(
  "1 0 * * *", 
  async () => {
    try {
      const now = new Date();
      const appointmentsRef = db.collection("Appointments");

      const snapshotUpcoming = await appointmentsRef.where("Status", "==", "Upcoming").get();
      const snapshotLate = await appointmentsRef.where("Status", "==", "Late").get();

      const appointments = [...snapshotUpcoming.docs, ...snapshotLate.docs];

      appointments.forEach(async (doc) => {
        const appointment = doc.data();
        const appointmentDateTime = new Date(`${appointment.Date}T${appointment.Time}:00`); // Combine date and time

        if (appointmentDateTime < now) {
            try {
                await appointmentsRef.doc(doc.id).update({ Status: "Failed" });
                console.log(`Appointment ${doc.id} marked as Failed.`);
              } catch (error) {
                console.error(`Error updating appointment ${doc.id}:`, error);
              }
        }
      });
    } catch (error) {
      console.error("Error updating appointments:", error);
    }
  },
  null,
  true,
  "UTC"
);

job.start();

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});