const express = require("express");
const admin = require("firebase-admin");
const cron = require("cron");
const fetch = require("node-fetch");
require("dotenv").config(); 

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); // Load from environment variables
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
console.log("Firebase initialized successfully");

const db = admin.firestore();
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

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

// New endpoint to verify reCAPTCHA token
app.post("/api/verify-recaptcha", async (req, res) => {
  const { token } = req.body;

  const secretKey = process.env.RECAPTCHA_SECRET_KEY; // Store your Secret Key in an environment variable

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