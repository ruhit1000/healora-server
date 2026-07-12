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

async function bootstrapServer() {
  try {
    await client.connect();
    console.log("🍃 MongoDB connected successfully via native driver");

    database = client.db("healora_db");

    sessionsCollection = database.collection("session");
    usersCollection = database.collection("user");
    doctorsCollection = database.collection("doctors");
    bookingsCollection = database.collection("bookings"); 

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

app.listen(port, () => {
  console.log(`Healora API listening smoothly on port ${port}`);
});

export default app;