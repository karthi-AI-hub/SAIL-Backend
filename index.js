const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const cors = require("cors");
const multer = require("multer");
require("dotenv").config();

const { supabase } = require('./supabaseClient');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("Firebase initialized successfully");
} catch (error) {
  console.error("Failed to initialize Firebase", error);
}

const db = admin.firestore();
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const corsOptions = {
  origin: ['https://ehms-sail.web.app', 'http://localhost:3000', 'http://localhost:3001'],
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload-report", upload.single("file"), async (req, res) => {
  const { file } = req;
  const { patientId, fileName, department, subDepartment, notes } = req.body; 

  if (!file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  if (!patientId) {
    return res.status(400).json({ error: "Patient ID is required" });
  }

  if (!department) {
    return res.status(400).json({ error: "Department is required" });
  }

  try {
    const filePath = subDepartment 
      ? `${patientId}/${department}/${subDepartment}/${fileName}` 
      : `${patientId}/${department}/${fileName}`;
      
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from("reports")
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
      });

    if (uploadError) {
      console.error("Error uploading file:", uploadError);
      throw uploadError;
    }

    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from("reports")
      .createSignedUrl(filePath, 180 * 24 * 60 * 60);

    if (signedUrlError) {
      console.error("Error generating signed URL:", signedUrlError);
      throw signedUrlError;
    }

    const metadata = {
      name: fileName,
      url: signedUrlData.signedUrl,
      size: (file.size / 1024).toFixed(2),
      uploadDate: new Date().toLocaleDateString(),
      expiryTime: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
      patientId,
      department,
      subDepartment: subDepartment || null,
      notes: notes || null,
    };

    const { data: dbData, error: dbError } = await supabase
      .from("reports_metadata")
      .insert([metadata]);

    if (dbError) {
      console.error("Error inserting metadata:", dbError);
      throw dbError;
    }

    res.status(200).json({ message: "File uploaded successfully", metadata });
  } catch (error) {
    console.error("Error uploading file:", error);
    res.status(500).json({ error: error.message || "Failed to upload file" });
  }
});

app.post("/get-reports", async (req, res) => {
  const { patientId } = req.body;

  if (!patientId) {
    return res.status(400).json({ error: "Patient ID is required" });
  }

  try {
    const { data: metadata, error: dbError } = await supabase
      .from("reports_metadata")
      .select("*")
      .eq("patientId", patientId);

    if (dbError) {
      console.error("Error fetching reports:", dbError);
      throw dbError;
    }

    if (!metadata || metadata.length === 0) {
      return res.status(404).json({ error: "No reports found for the provided Patient ID" });
    }

    res.status(200).json(metadata);
  } catch (error) {
    console.error("Error fetching reports:", error);
    res.status(500).json({ error: error.message || "Failed to fetch reports" });
  }
});

app.post("/regenerate-signed-url", async (req, res) => {
  const { filePath } = req.body;

  try {
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from("reports")
      .createSignedUrl(filePath, 180 * 24 * 60 * 60);
    if (signedUrlError) {
      console.error("Error generating signed URL:", signedUrlError);
      throw signedUrlError;
    }

    const newExpiryTime = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
    const { data: updateData, error: updateError } = await supabase
      .from("reports_metadata")
      .update({ expiryTime: newExpiryTime })
      .eq("name", filePath.split('/').pop());

    if (updateError) {
      console.error("Error updating metadata:", updateError);
      throw updateError;
    }

    res.status(200).json({ signedUrl: signedUrlData.signedUrl });
  } catch (error) {
    console.error("Error regenerating signed URL:", error);
    res.status(500).json({ error: "Failed to regenerate signed URL" });
  }
});

app.post("/archive-report", async (req, res) => {
  const { name } = req.body;

  try {
    const { data, error } = await supabase
      .from("reports_metadata")
      .update({ department: "ARCHIVED" })
      .eq("name", name);

    if (error) {
      console.error("Error archiving report:", error);
      throw error;
    }

    res.status(200).json({ message: "Report archived successfully" });
  } catch (error) {
    console.error("Error archiving report:", error);
    res.status(500).json({ error: "Failed to archive report" });
  }
});

app.post("/delete-report", async (req, res) => {
  const { name, technicianId, timestamp, reason } = req.body;

  try {
    const { data: reportData, error: fetchError } = await supabase
      .from("reports_metadata")
      .select("*")
      .eq("name", name)
      .single();

    if (fetchError || !reportData) {
      console.error("Error fetching report metadata:", fetchError);
      throw fetchError || new Error("Report not found");
    }

    const { patientId, department, subDepartment } = reportData;
    const oldFilePath = subDepartment 
      ? `${patientId}/${department}/${subDepartment}/${name}` 
      : `${patientId}/${department}/${name}`;
    const newFilePath = `${patientId}/DELETED/${name}`;

    // const { data: fileData, error: fileError } = await supabase.storage
    //   .from("reports")
    //   .download(oldFilePath);

    // if (fileError || !fileData) {
    //   console.error("File not found:", fileError);
    //   throw new Error("File not found");
    // }

    const { data: moveData, error: moveError } = await supabase.storage
      .from("reports")
      .move(oldFilePath, newFilePath);

    if (moveError) {
      console.error("Error moving file:", moveError);
      throw moveError;
    }

    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from("reports")
      .createSignedUrl(newFilePath, 180 * 24 * 60 * 60);

      if (signedUrlError) {
        console.error("Error generating signed URL:", signedUrlError);
        throw signedUrlError;
      }

    const { error: deleteError } = await supabase
      .from("reports_metadata")
      .delete()
      .eq("name", name);

    if (deleteError) {
      console.error("Error deleting metadata:", deleteError);
      throw deleteError;
    }

    const { error: insertError } = await supabase
      .from("deleted_reports")
      .insert([{
        name,
        technicianId,
        timestamp,
        reason,
        url: signedUrlData.signedUrl,
        patientId,
        department,
        subDepartment,
      }]);

    if (insertError) {
      console.error("Error inserting into deleted_reports:", insertError);
      throw insertError;
    }

    res.status(200).json({ message: "Report deleted successfully" });
  } catch (error) {
    console.log("Old File Path:", oldFilePath);
    console.log("New File Path:", newFilePath);
    console.error("Error deleting report:", error);
    res.status(500).json({ error: "Failed to delete report" });
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

app.get("/get-patient", async (req, res) => {
  const { patientId } = req.query;

  try {
    const patientDoc = await db.collection("Employee").doc(patientId).get();
    if (!patientDoc.exists) {
      return res.status(404).json({ exists: false });
    }
    res.status(200).json({ exists: true, data: patientDoc.data() });
  } catch (error) {
    console.error("Error fetching patient:", error);
    res.status(500).json({ error: "Failed to fetch patient" });
  }
});

app.get("/get-family", async (req, res) => {
  const { patientId } = req.query;

  try {
    const familySnapshot = await db.collection("Employee").doc(patientId).collection("Family").get();
    const family = familySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ family });
  } catch (error) {
    console.error("Error fetching family data:", error);
    res.status(500).json({ error: "Failed to fetch family data" });
  }
});

app.post("/update-appointments", async (req, res) => {
  try {
    const now = new Date();
    const appointmentsRef = db.collection("Appointments");

    const snapshotUpcoming = await appointmentsRef.where("Status", "==", "Upcoming").get();
    const snapshotLate = await appointmentsRef.where("Status", "==", "Late").get();

    const appointments = [...snapshotUpcoming.docs, ...snapshotLate.docs];

    appointments.forEach(async (doc) => {
      const appointment = doc.data();
      const appointmentDate = new Date(appointment.Date);
      const appointmentDateTime = new Date(`${appointment.Date}T${appointment.Time}:00`);

      if (appointmentDate < now.setHours(0, 0, 0, 0)) {
        try {
          await appointmentsRef.doc(doc.id).update({ Status: "Failed" });
          console.log(`Appointment ${doc.id} marked as Failed.`);
        } catch (error) {
          console.error(`Error updating appointment ${doc.id}:`, error);
        }
      } else if (appointmentDateTime < now) {
        try {
          await appointmentsRef.doc(doc.id).update({ Status: "Late" });
          console.log(`Appointment ${doc.id} marked as Late.`);
        } catch (error) {
          console.error(`Error updating appointment ${doc.id}:`, error);
        }
      }
    });

    res.status(200).json({ message: "Cron job executed successfully" });
  } catch (error) {
    console.error("Error running cron job:", error);
    res.status(500).json({ error: "Failed to run cron job" });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});