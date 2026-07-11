import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { MongoClient, ServerApiVersion, ObjectId, Db, Collection } from "mongodb";
import dns from "dns";
import dotenv from "dotenv";

dotenv.config();

dns.setServers(["8.8.8.8", "1.1.1.1"]);

const app = express();
const port = process.env.PORT || 8000;

// Universal Middleware Layout
app.use(cors());
app.use(express.json());

// Explicit TypeScript Interface Mapping for Global Routing Context Injection
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

// Global collection definitions explicitly mapped with proper TypeScript strict checks
let database: Db;
let sessionsCollection: Collection;
let usersCollection: Collection;
let doctorsCollection: Collection;

async function bootstrapServer() {
  try {
    await client.connect();
    console.log("🍃 MongoDB connected successfully via native driver");

    database = client.db("healora_db");
    
    // Core structural collections
    sessionsCollection = database.collection("sessions");
    usersCollection = database.collection("users");
    doctorsCollection = database.collection("doctors");

    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } catch (error) {
    console.error("❌ Failed to bind native MongoDB instance:", error);
  }
}
bootstrapServer();

/* =========================================================================
       1. CUSTOM DATABASE SESSION VERIFICATION MIDDLEWARE
       ========================================================================= */
const verifyToken = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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

    const user = await usersCollection.findOne({ _id: new ObjectId(session.userId as string) });
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
const verifyAdmin = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== "admin") {
    return res.status(403).send({ message: "Forbidden Access" });
  }
  next();
};

const verifyDoctor = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== "doctor") {
    return res.status(403).send({ message: "Forbidden Access" });
  }
  next();
};

const verifyPatient = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== "patient") {
    return res.status(403).send({ message: "Forbidden Access" });
  }
  next();
};

/* =========================================================================
       3. CORE API ENDPOINTS
       ========================================================================= */

// HOME BASE ROUTE (PUBLIC)
app.get("/", (req: Request, res: Response) => {
  res.send("Healora Secure Medical Scheduling Backend: ONLINE");
});

/* =========================================================================
       PUBLIC DIRECTORY DIRECTORY SEARCH & PAGINATION ENGINE
       ========================================================================= */

// GET ALL APPROVED PUBLIC DOCTORS (WITH SEARCH, FILTER & PAGINATION)
app.get("/api/doctors", async (req: Request, res: Response) => {
  try {
    // 1. Destructure Query Parameters
    const { search, specialty, page } = req.query;

    // 2. Build the Safe Filter Object
    // We strictly query only approved doctors to safeguard patients
    const filterQuery: any = { isApproved: true };

    // Handle Optional Name Search (Case-Insensitive Regex)
    if (search && typeof search === "string") {
      filterQuery.name = { $regex: search, $options: "i" };
    }

    // Handle Optional Specialty Filter
    if (specialty && typeof specialty === "string") {
      filterQuery.specialty = specialty;
    }

    // 3. Configure Pagination Controls
    const itemsPerPage = 12;
    // Safely parse out user page parameters, defaulting to page 1
    const currentPage = page ? parseInt(page as string, 10) : 1;
    const skipCount = (currentPage - 1) * itemsPerPage;

    // 4. Calculate Total Documents Matrix for Frontend Page Controls
    const totalMatchingDoctors = await doctorsCollection.countDocuments(filterQuery);
    const totalPages = Math.ceil(totalMatchingDoctors / itemsPerPage);

    // 5. Query Database with Projection Optimization
    // We explicitly project only card fields, omitting heavy biographical/history strings
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
        patientSatisfactoryScore: { averageRating: 1 }
      })
      .skip(skipCount)
      .limit(itemsPerPage)
      .toArray();

    // 6. Return Structured Unified Response Payload
    res.status(200).json({
      success: true,
      meta: {
        totalDoctors: totalMatchingDoctors,
        totalPages: totalPages,
        currentPage: currentPage,
        limit: itemsPerPage
      },
      data: doctors
    });

  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: "Failed to parse directory registry database metadata",
      error: error.message
    });
  }
});

// GET ALL UNIQUE SPECIALTIES FROM APPROVED DOCTORS (PUBLIC)
app.get("/api/doctors/specialties", async (req: Request, res: Response) => {
  try {
    const aggregationResult = await doctorsCollection
      .aggregate([
        { 
          $match: { isApproved: { $in: [true, "true"] } } 
        },
        { 
          $group: { _id: "$specialty" } 
        },
        { 
          $sort: { _id: 1 } 
        }
      ])
      .toArray();

    const cleanSpecialties = aggregationResult
      .map(item => item._id)
      .filter((spec): spec is string => typeof spec === "string" && spec.trim() !== "");

    res.status(200).json({
      success: true,
      data: cleanSpecialties
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: "Failed to compile dynamic specialty registry map",
      error: error.message
    });
  }
});

app.listen(port, () => {
  console.log(`Healora API listening smoothly on port ${port}`);
});

module.exports = app;