import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import {
  MongoClient,
  ServerApiVersion,
  ObjectId,
  Db,
  Collection,
} from "mongodb";
import dns from "dns";
import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();

dns.setServers(["8.8.8.8", "1.1.1.1"]);

const app = express();
const port = process.env.PORT || 8000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);
const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";

// Universal Middleware Layout - Locked down to your specific frontend URL
app.use(cors({
  origin: clientUrl
}));

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET as string;

/* =========================================================================
   ⚠️ STRIPE WEBHOOK (MUST GO BEFORE express.json() IS CALLED)
   ========================================================================= */
app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig as string,
        endpointSecret,
      );
    } catch (err: any) {
      console.error(`Webhook signature verification failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const bookingId = session.metadata?.bookingId;

      if (bookingId) {
        try {
          await bookingsCollection.updateOne(
            { _id: new ObjectId(bookingId) },
            {
              $set: {
                paymentStatus: "Paid",
                bookingStatus: "Confirmed",
                updatedAt: new Date(),
              },
              $unset: {
                lockExpiresAt: "",
              },
            },
          );
          console.log(`✅ SUCCESS: Booking ${bookingId} confirmed and paid.`);
        } catch (dbError) {
          console.error("Failed to update booking status in MongoDB:", dbError);
        }
      }
    }

    res.status(200).send();
  },
);

// NOW you can apply standard JSON parsing for all the other routes
app.use(express.json());

interface AuthenticatedRequest extends Request {
  user?: any;
}

// Database Connection Orchestration
const uri = process.env.MONGO_URI || "";
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let database: Db;
let sessionsCollection: Collection;
let usersCollection: Collection;
let doctorsCollection: Collection;
let bookingsCollection: Collection; 
let profilesCollection: Collection;

async function bootstrapServer() {
  try {
    await client.connect();
    console.log("🍃 MongoDB connected successfully via native driver");

    database = client.db("healora_db");

    sessionsCollection = database.collection("session");
    usersCollection = database.collection("user");
    doctorsCollection = database.collection("doctors");
    bookingsCollection = database.collection("bookings"); 
    profilesCollection = database.collection("profiles");

    await profilesCollection.createIndex({ userId: 1 }, { unique: true });
    console.log("👤 Unique index established on profilesCollection");

    // 1. Auto-Delete TTL Index for abandoned checkouts
    await bookingsCollection.createIndex(
      { lockExpiresAt: 1 },
      { expireAfterSeconds: 0 },
    );
    console.log("⏱️ TTL Index established on bookingsCollection");

    // 2. Strict Unique Index to prevent millisecond race-condition double bookings
    await bookingsCollection.createIndex(
      { doctorId: 1, appointmentDate: 1, appointmentTime: 1 },
      { unique: true }
    );
    console.log("🔒 Unique constraint index established on bookingsCollection");

    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } catch (error) {
    console.error("❌ Failed to bind native MongoDB instance:", error);
  }
}
bootstrapServer();

/* =========================================================================
       1. CUSTOM DATABASE SESSION VERIFICATION MIDDLEWARE
       ========================================================================= */
const verifyToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).send({ message: "Unauthorized Access" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).send({ message: "Unauthorized Access" });
    }

    const session = await sessionsCollection.findOne({ token: token });
    if (!session) {
      return res.status(401).send({ message: "Unauthorized Access" });
    }

    const user = await usersCollection.findOne({
      _id: new ObjectId(session.userId as string),
    });
    if (!user) {
      return res.status(401).send({ message: "Unauthorized Access" });
    }

    req.user = user;
    next();
  } catch (error: any) {
    return res
      .status(500)
      .send({ message: "Internal Auth Exception", error: error.message });
  }
};

/* =========================================================================
       2. ROLE SPECIFIC VERIFICATION MIDDLEWARES
       ========================================================================= */
const verifyAdmin = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.user?.role !== "admin") {
    return res.status(403).send({ message: "Forbidden Access" });
  }
  next();
};

const verifyDoctor = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.user?.role !== "doctor") {
    return res.status(403).send({ message: "Forbidden Access" });
  }
  next();
};

const verifyPatient = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.user?.role !== "patient") {
    return res.status(403).send({ message: "Forbidden Access" });
  }
  next();
};

/* =========================================================================
       3. CORE API ENDPOINTS
       ========================================================================= */

app.get("/", (req: Request, res: Response) => {
  res.send("Healora Secure Medical Scheduling Backend: ONLINE");
});

app.get("/api/doctors", async (req: Request, res: Response) => {
  try {
    const { search, specialty, page } = req.query;
    const filterQuery: any = { isApproved: true };

    if (search && typeof search === "string") {
      filterQuery.name = { $regex: search, $options: "i" };
    }
    if (specialty && typeof specialty === "string") {
      filterQuery.specialty = specialty;
    }

    const itemsPerPage = 12;
    const currentPage = page ? parseInt(page as string, 10) : 1;
    const skipCount = (currentPage - 1) * itemsPerPage;
    const totalMatchingDoctors =
      await doctorsCollection.countDocuments(filterQuery);
    const totalPages = Math.ceil(totalMatchingDoctors / itemsPerPage);

    const doctors = await doctorsCollection
      .find(filterQuery)
      .project({
        name: 1,
        title: 1,
        image: 1,
        specialty: 1,
        fee: 1,
        location: 1,
        availabilitySummary: 1,
        patientSatisfactoryScore: { averageRating: 1 },
      })
      .skip(skipCount)
      .limit(itemsPerPage)
      .toArray();

    res.status(200).json({
      success: true,
      meta: {
        totalDoctors: totalMatchingDoctors,
        totalPages,
        currentPage,
        limit: itemsPerPage,
      },
      data: doctors,
    });
  } catch (error: any) {
    res
      .status(500)
      .json({
        success: false,
        message: "Failed to parse directory",
        error: error.message,
      });
  }
});

app.get("/api/doctors/specialties", async (req: Request, res: Response) => {
  try {
    const aggregationResult = await doctorsCollection
      .aggregate([
        { $match: { isApproved: { $in: [true, "true"] } } },
        { $group: { _id: "$specialty" } },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    const cleanSpecialties = aggregationResult
      .map((item) => item._id)
      .filter(
        (spec): spec is string =>
          typeof spec === "string" && spec.trim() !== "",
      );

    res.status(200).json({ success: true, data: cleanSpecialties });
  } catch (error: any) {
    res
      .status(500)
      .json({
        success: false,
        message: "Failed to compile specialty registry",
        error: error.message,
      });
  }
});

app.get("/api/doctors/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string" || !ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid Doctor ID format" });
    }

    const doctor = await doctorsCollection.findOne({ _id: new ObjectId(id) });
    if (!doctor) {
      return res
        .status(404)
        .json({ success: false, message: "Profile not found" });
    }
    if (doctor.isApproved !== true && doctor.isApproved !== "true") {
      return res
        .status(403)
        .json({ success: false, message: "Profile pending verification" });
    }

    res.status(200).json({ success: true, data: doctor });
  } catch (error: any) {
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

/* =========================================================================
       4. BOOKING & CHECKOUT ENGINE
       ========================================================================= */

app.get("/api/bookings/schedule", async (req: Request, res: Response) => {
  try {
    const { doctorId, date } = req.query;

    if (
      !doctorId ||
      typeof doctorId !== "string" ||
      !date ||
      typeof date !== "string"
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Doctor ID and date required" });
    }

    const bookedSlots = await bookingsCollection
      .find({
        doctorId: new ObjectId(doctorId),
        appointmentDate: date,
        bookingStatus: { $in: ["Locked", "Confirmed"] },
      })
      .project({ appointmentTime: 1 })
      .toArray();

    const disabledTimes = bookedSlots.map((b) => b.appointmentTime);

    res.status(200).json({ success: true, data: disabledTimes });
  } catch (error: any) {
    res
      .status(500)
      .json({
        success: false,
        message: "Failed to fetch schedule",
        error: error.message,
      });
  }
});

app.post(
  "/api/bookings/initialize",
  verifyToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { doctorId, appointmentDate, appointmentTime, intake } = req.body;
      const patientUserId = req.user._id;

      const existingBooking = await bookingsCollection.findOne({
        doctorId: new ObjectId(doctorId as string),
        appointmentDate,
        appointmentTime,
        bookingStatus: { $in: ["Locked", "Confirmed"] },
      });

      if (existingBooking) {
        return res.status(409).json({
          success: false,
          message:
            "This slot was just booked by someone else. Please choose another time.",
        });
      }

      const doctor = await doctorsCollection.findOne({
        _id: new ObjectId(doctorId as string),
      });
      if (!doctor) {
        return res
          .status(404)
          .json({ success: false, message: "Doctor not found." });
      }

      const now = new Date();
      const lockExpiration = new Date(now.getTime() + 10 * 60 * 1000);

      const newBookingDocument = {
        patientUserId: patientUserId, 
        doctorId: new ObjectId(doctorId as string),
        appointmentDate,
        appointmentTime,
        patientDetails: {
          patientName: intake.patientName,
          age: Number(intake.age),
          gender: intake.gender,
          reasonForVisit: intake.reason || "",
        },
        consultationFee: doctor.fee,
        bookingStatus: "Locked",
        paymentStatus: "Pending",
        lockExpiresAt: lockExpiration,
        createdAt: now,
        updatedAt: now,
      };

      const insertResult =
        await bookingsCollection.insertOne(newBookingDocument);
      const newBookingId = insertResult.insertedId.toString();

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        customer_email: req.user?.email || undefined, // Safely handles missing emails
        line_items: [
          {
            price_data: {
              currency: "bdt", // Swap to "usd" if your live Stripe rejects bdt
              product_data: {
                name: `Consultation with ${doctor.name}`,
                description: `${appointmentDate} @ ${appointmentTime} for ${intake.patientName}`,
              },
              unit_amount: Math.round(doctor.fee * 100), // Prevents crash from decimals
            },
            quantity: 1,
          },
        ],
        metadata: { bookingId: newBookingId },
        success_url: `${clientUrl}/booking-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${clientUrl}/doctors/${doctorId}?payment=cancelled`,
      });

      await bookingsCollection.updateOne(
        { _id: insertResult.insertedId },
        { $set: { stripeSessionId: session.id, updatedAt: new Date() } },
      );

      res.status(200).json({ success: true, url: session.url });
    } catch (error: any) {
      // Handles race condition rejection from the new unique index
      if (error.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "This slot was just booked by someone else. Please choose another time.",
        });
      }

      console.error(error);
      res
        .status(500)
        .json({
          success: false,
          message: "Checkout failed",
          error: error.message,
        });
    }
  },
);

// Dashboard API Endpoints for Patients
// Overview of bookings, payment status, and upcoming appointments
app.get(
  "/api/patient/dashboard/overview",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const patientUserId = req.user._id;

      // 1. Get today's date as a string (assuming appointmentDate is stored as YYYY-MM-DD)
      const today = new Date();
      // Adjusting for your timezone (Bangladesh) to ensure accurate "today" calculations
      const todayStr = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split("T")[0];

      // 2. Fetch all upcoming confirmed bookings
      const upcomingBookings = await bookingsCollection
        .find({
          patientUserId: patientUserId,
          bookingStatus: "Confirmed",
          appointmentDate: { $gte: todayStr },
        })
        .sort({ appointmentDate: 1, appointmentTime: 1 })
        .toArray();

      const upcomingCount = upcomingBookings.length;
      let nextAppointment = upcomingBookings[0] || null;

      // If there is a next appointment, fetch the doctor's details for the UI card
      if (nextAppointment) {
        const doctor = await doctorsCollection.findOne(
          { _id: new ObjectId(nextAppointment.doctorId) },
          { projection: { name: 1, specialty: 1, location: 1, image: 1 } }
        );
        nextAppointment.doctorDetails = doctor;
      }

      // 3. Calculate total spent (Payment Status: Paid)
      const paidBookings = await bookingsCollection
        .find({ patientUserId: patientUserId, paymentStatus: "Paid" })
        .project({ consultationFee: 1 })
        .toArray();
      
      const totalSpent = paidBookings.reduce((sum, booking) => sum + (booking.consultationFee || 0), 0);

      // 4. Count total completed consultations
      const completedCount = await bookingsCollection.countDocuments({
        patientUserId: patientUserId,
        bookingStatus: "Completed",
      });

      // 5. Fetch Recent Activity (Last 3 appointments, either past dates or completed/cancelled)
      const recentActivity = await bookingsCollection
        .find({
          patientUserId: patientUserId,
          $or: [
            { bookingStatus: { $in: ["Completed", "Cancelled"] } },
            { appointmentDate: { $lt: todayStr } }
          ]
        })
        .sort({ appointmentDate: -1, createdAt: -1 })
        .limit(3)
        .toArray();

      // Attach doctor names to recent activity for the UI table
      const recentActivityWithDoctors = await Promise.all(
        recentActivity.map(async (activity) => {
          const doctor = await doctorsCollection.findOne(
            { _id: new ObjectId(activity.doctorId) },
            { projection: { name: 1, specialty: 1 } }
          );
          return { ...activity, doctorDetails: doctor };
        })
      );

      // 6. Send the aggregated payload
      res.status(200).json({
        success: true,
        data: {
          stats: {
            upcomingCount,
            completedCount,
            totalSpent,
          },
          nextAppointment,
          recentActivity: recentActivityWithDoctors,
        },
      });
    } catch (error: any) {
      console.error("Dashboard Overview Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to load dashboard data",
        error: error.message,
      });
    }
  }
);

app.get(
  "/api/patient/dashboard/appointments",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const patientUserId = req.user._id;

      // Get current date string (YYYY-MM-DD) for accurate future filtering
      const today = new Date();
      const todayStr = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split("T")[0];

      // Fetch upcoming appointments that are either Confirmed or actively Locked
      const appointments = await bookingsCollection
        .find({
          patientUserId: patientUserId,
          bookingStatus: { $in: ["Confirmed", "Locked"] },
          appointmentDate: { $gte: todayStr },
        })
        .sort({ appointmentDate: 1, appointmentTime: 1 })
        .toArray();

      // Stitch doctor profile information onto each appointment payload
      const populatedAppointments = await Promise.all(
        appointments.map(async (appt) => {
          const doctor = await doctorsCollection.findOne(
            { _id: new ObjectId(appt.doctorId) },
            { projection: { name: 1, specialty: 1, image: 1, location: 1 } }
          );
          
          // Explicitly return the spread fields alongside doctorDetails
          return {
            ...appt,
            bookingStatus: appt.bookingStatus,
            doctorDetails: doctor
          };
        })
      );

      // Separate the appointments into active vs pending channels for frontend tabs
      const confirmed = populatedAppointments.filter(a => a.bookingStatus === "Confirmed");
      const pending = populatedAppointments.filter(a => a.bookingStatus === "Locked");

      res.status(200).json({
        success: true,
        data: {
          confirmed,
          pending
        }
      });
    } catch (error: any) {
      console.error("Fetch Patient Appointments Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to load appointments",
        error: error.message,
      });
    }
  }
);

app.get(
  "/api/patient/dashboard/history",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const patientUserId = req.user._id;

      const today = new Date();
      const todayStr = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split("T")[0];

      // Fetch appointments that are either Completed, Cancelled, OR fall in the past
      const history = await bookingsCollection
        .find({
          patientUserId: patientUserId,
          $or: [
            { bookingStatus: { $in: ["Completed", "Cancelled"] } },
            { appointmentDate: { $lt: todayStr } }
          ]
        })
        .sort({ appointmentDate: -1, appointmentTime: -1 }) // Most recent past visits first
        .toArray();

      // Stitch doctor profile information onto each history item
      const populatedHistory = await Promise.all(
        history.map(async (appt) => {
          const doctor = await doctorsCollection.findOne(
            { _id: new ObjectId(appt.doctorId) },
            { projection: { name: 1, specialty: 1, image: 1 } }
          );
          
          return {
            ...appt,
            bookingStatus: appt.bookingStatus,
            doctorDetails: doctor
          };
        })
      );

      res.status(200).json({
        success: true,
        data: populatedHistory
      });
    } catch (error: any) {
      console.error("Fetch Patient History Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to load consultation history",
        error: error.message,
      });
    }
  }
);

// 1. GET PATIENT PROFILE DATA
app.get(
  "/api/patient/profile",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user._id;

      // Find extended profile information if it exists
      const extendedProfile = await profilesCollection.findOne({
        userId: new ObjectId(userId),
      });

      // Combine BetterAuth core user data with our extended medical data
      res.status(200).json({
        success: true,
        data: {
          name: req.user.name,
          email: req.user.email,
          phone: extendedProfile?.phone || "",
          gender: extendedProfile?.gender || "",
          dateOfBirth: extendedProfile?.dateOfBirth || "",
          bloodGroup: extendedProfile?.bloodGroup || "",
          address: extendedProfile?.address || "",
          emergencyContact: extendedProfile?.emergencyContact || "",
        },
      });
    } catch (error: any) {
      console.error("Fetch Profile Error:", error);
      res.status(500).json({ success: false, message: "Failed to load profile state", error: error.message });
    }
  }
);

// 2. UPDATE / UPSERT PATIENT PROFILE DATA
app.post(
  "/api/patient/profile",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user._id;
      const { name, phone, gender, dateOfBirth, bloodGroup, address, emergencyContact } = req.body;

      // Update core user display name in BetterAuth users collection
      await usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        { $set: { name, updatedAt: new Date() } }
      );

      // Upsert extended details inside our custom profiles collection
      await profilesCollection.updateOne(
        { userId: new ObjectId(userId) },
        {
          $set: {
            phone,
            gender,
            dateOfBirth,
            bloodGroup,
            address,
            emergencyContact,
            updatedAt: new Date(),
          },
        },
        { upsert: true } // Creates the document if it doesn't exist yet
      );

      res.status(200).json({ success: true, message: "Profile synchronized successfully" });
    } catch (error: any) {
      console.error("Update Profile Error:", error);
      res.status(500).json({ success: false, message: "Failed to update profile changes", error: error.message });
    }
  }
);

app.listen(port, () => {
  console.log(`Healora API listening smoothly on port ${port}`);
});

export default app;