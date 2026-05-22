Database design: Emma Williams

Original database version (see my other repository): Austen Chen, Alex Williams, Emma Williams

All changes made between this version and the original Torrey Database: Emma Williams

Notes:

Compared to the original version, the initial data file has a completely filled out lecture table with the 182 lectures that are curricular and on the Torrey archive as of today, May 22nd, 2026, while the initial one only had 42 as a sample because Austen was short on time. Also, this has the added intermediary book_lectures table which was in my original design but which we ran out of time to complete for the class. This table is also filled to properly connect all of the lectures to the books they are on.

Also of note, the primary keys for the books has been changed from being the books' ISBN numbers (with arbitrary ones being used for the Bible) in the original version to being a created ID, where it contains the first three letters of the author's last name (if multiple authors, the author is unknown, or if it's a Bible book then this part is replaced with "UNK"), and then the first 5 letters of the book (spaces excluded, and if the book starts with "The " or "A", that part is skipped as well). The reason for this change is mainly because after talking with the Assistant Director of Torrey Honors (who happens to be my mentor), he said that using ISBN numbers would be very impractical given that Torrey regularly changes which book edition we use as the main one for the curriculum, since versions often go out of print. So, I needed a new solution. This format is pretty good because my end goal is for the Torrey admin to need to actually use this id number as minimally as possible to make it more user friendly for them. This format is such that the computer can generate the id from the more user-friendly input that the admin will provide, making this id more internal. Also, it is convenient for me, who is using this id directly, because I can much more easily tell from the ID which book it's referring to, unlike an ISBN number.
