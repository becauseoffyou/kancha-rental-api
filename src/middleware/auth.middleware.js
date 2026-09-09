const jwt = require("jsonwebtoken");

const JWT_SECRET =
    process.env.JWT_SECRET || "kancha-dev-secret";

const authMiddleware = (req, res, next) => {
    try {
        const authHeader =
            req.headers.authorization;

        if (
            !authHeader ||
            !authHeader.startsWith("Bearer ")
        ) {
            return res.status(401).json({
                success: false,
                message: "Token tidak ditemukan",
            });
        }

        const token =
            authHeader.split(" ")[1];

        const decoded =
            jwt.verify(
                token,
                JWT_SECRET
            );

        req.user = decoded;

        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message:
                "Token tidak valid atau sudah kadaluarsa",
        });
    }
};

module.exports = authMiddleware;